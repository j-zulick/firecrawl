import { SupabaseClient } from "@supabase/supabase-js";
import { logger as _logger } from "../logger";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "../otel-tracer";
import { generateEmbedding, isEmbeddingEnabled } from "./embeddings";
import {
  searchPinecone,
  isPineconeEnabled,
  buildPineconeFilter,
} from "./pinecone-service";

export interface SearchQuery {
  query: string;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
  mode?: "hybrid" | "keyword" | "semantic";
}

export interface SearchFilters {
  domain?: string;
  country?: string;
  isMobile?: boolean;
  minFreshness?: number;
  language?: string;
}

export interface SearchResult {
  documentId: string;
  url: string;
  title: string | null;
  description: string | null;
  domain: string;
  snippet?: string;
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  freshnessScore: number;
  qualityScore: number;
  lastCrawledAt: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  mode: string;
  took: number; // milliseconds
}

/**
 * Main search function: hybrid search with RRF ranking
 */
export async function search(
  supabase: SupabaseClient,
  searchQuery: SearchQuery,
  logger?: Logger,
): Promise<SearchResponse> {
  return await withSpan("firecrawl-search", async span => {
    const log = logger ?? _logger.child({ module: "search-query" });
    const startTime = Date.now();
    
    const {
      query,
      limit = 50,
      offset = 0,
      filters = {},
      mode = "hybrid",
    } = searchQuery;
    
    setSpanAttributes(span, {
      "search.query": query,
      "search.limit": limit,
      "search.mode": mode,
      "search.filters": JSON.stringify(filters),
    });
    
    if (!query || query.trim().length === 0) {
      return {
        results: [],
        total: 0,
        query,
        mode,
        took: Date.now() - startTime,
      };
    }
    
  try {
    let results: SearchResult[] = [];
    
    // Fetch enough results to support pagination
    const fetchLimit = limit + offset;
    
    // Choose search strategy based on mode
    if (mode === "keyword") {
      results = await keywordSearch(supabase, query, fetchLimit, filters, log);
    } else if (mode === "semantic") {
      results = await semanticSearch(supabase, query, fetchLimit, filters, log);
    } else {
      // Hybrid: combine BM25 + vector with RRF
      results = await hybridSearch(supabase, query, fetchLimit, filters, log);
    }
    
    // Apply offset and limit for pagination
    const paginatedResults = results.slice(offset, offset + limit);
      
      const took = Date.now() - startTime;
      
      setSpanAttributes(span, {
        "search.results_count": results.length,
        "search.took_ms": took,
      });
      
      log.info("Search completed", {
        query,
        mode,
        results: results.length,
        took,
      });
      
      return {
        results: paginatedResults,
        total: results.length,
        query,
        mode,
        took,
      };
    } catch (error) {
      log.error("Search failed", {
        error: (error as Error).message,
        query,
      });
      
      setSpanAttributes(span, {
        "search.error": true,
        "search.error_message": (error as Error).message,
      });
      
      return {
        results: [],
        total: 0,
        query,
        mode,
        took: Date.now() - startTime,
      };
    }
  });
}

/**
 * Hybrid search: BM25 (Postgres) + Vector (Pinecone) with RRF ranking
 */
async function hybridSearch(
  supabase: SupabaseClient,
  query: string,
  limit: number,
  filters: SearchFilters,
  logger: Logger,
): Promise<SearchResult[]> {
  // Generate query embedding for vector search
  let queryEmbedding: number[] | null = null;
  
  if (isEmbeddingEnabled() && isPineconeEnabled()) {
    try {
      const embResult = await generateEmbedding(query, {}, logger);
      queryEmbedding = embResult.embedding;
    } catch (error) {
      logger.warn("Failed to generate query embedding, falling back to keyword search", {
        error: (error as Error).message,
      });
    }
  }
  
  // If no embedding, fall back to keyword search
  if (!queryEmbedding) {
    return keywordSearch(supabase, query, limit, filters, logger);
  }
  
  // Parallel search: BM25 in Postgres + Vector in Pinecone
  const [bm25Results, vectorResults] = await Promise.all([
    // BM25 search in Postgres
    supabase.rpc("bm25_search", {
      query_text: query,
      result_limit: 100,
      country_filter: filters.country ?? null,
      domain_filter: filters.domain ?? null,
      is_mobile_filter: filters.isMobile ?? null,
      min_freshness: filters.minFreshness ?? 0.0,
    }),
    
    // Vector search in Pinecone
    (async () => {
      try {
        const pineconeFilter = buildPineconeFilter(filters);
        const results = await searchPinecone(
          queryEmbedding!,
          100,
          pineconeFilter,
          "documents",
          logger,
        );
        return results;
      } catch (error) {
        logger.warn("Pinecone search failed, continuing with BM25 only", {
          error: (error as Error).message,
        });
        return [];
      }
    })(),
  ]);
  
  if (bm25Results.error) {
    logger.error("BM25 search failed", { error: bm25Results.error.message });
    throw new Error(`BM25 search failed: ${bm25Results.error.message}`);
  }
  
  // Extract Pinecone doc IDs
  const pineconeDocIds = vectorResults
    .map(r => r.metadata.doc_id)
    .filter(Boolean) as string[];
  
  // Get metadata for Pinecone results from Postgres
  const { data: pineconeMetadata } = await supabase.rpc("get_documents_metadata", {
    doc_ids: pineconeDocIds,
  });
  
  // Create map of doc_id -> metadata
  const metadataMap = new Map(
    (pineconeMetadata || []).map((m: any) => [m.doc_id, m])
  );
  
  // Merge results with RRF
  const bm25Map = new Map<string, any>(
    (bm25Results.data || []).map((r: any, index: number) => [
      r.doc_id,
      { rank: index + 1, ...r },
    ])
  );
  
  const vectorMap = new Map<string, { rank: number; score: number }>(
    vectorResults.map((r, index) => [
      r.metadata.doc_id || r.id,
      { rank: index + 1, score: r.score },
    ])
  );
  
  // Combine all unique doc IDs
  const allDocIds = new Set([
    ...bm25Map.keys(),
    ...vectorMap.keys(),
  ]);
  
  const k = 60; // RRF constant
  const merged: SearchResult[] = [];
  
  for (const docId of allDocIds) {
    const bm25 = bm25Map.get(docId);
    const vector = vectorMap.get(docId);
    
    // RRF score
    const bm25Rank = bm25?.rank ?? null;
    const vectorRank = vector?.rank ?? null;
    
    const rrf = 
      (bm25Rank ? 1 / (k + bm25Rank) : 0) + 
      (vectorRank ? 1 / (k + vectorRank) : 0);
    
    // Get metadata (prefer from BM25 result, fallback to Pinecone metadata)
    const metadata: any = bm25 || metadataMap.get(docId);
    
    if (!metadata) continue;
    
    const combinedScore =
      rrf * (metadata.freshness_score || 1.0) * (metadata.quality_score || 1.0);
    
    merged.push({
      documentId: docId,
      url: metadata.url,
      title: metadata.title,
      description: metadata.description,
      domain: metadata.domain,
      score: combinedScore,
      bm25Rank,
      vectorRank,
      freshnessScore: metadata.freshness_score || 1.0,
      qualityScore: metadata.quality_score || 1.0,
      lastCrawledAt: metadata.last_crawled_at,
    });
  }
  
  // Sort by combined score
  merged.sort((a, b) => b.score - a.score);
  
  return merged.slice(0, limit);
}

/**
 * Keyword-only search (BM25)
 */
async function keywordSearch(
  supabase: SupabaseClient,
  query: string,
  limit: number,
  filters: SearchFilters,
  logger: Logger,
): Promise<SearchResult[]> {
  let queryBuilder = supabase
    .from("search_documents")
    .select(
      "id, resolved_url, title, description, domain, freshness_score, quality_score, last_crawled_at, content_ts",
    )
    .textSearch("content_ts", query, {
      type: "plain",
      config: "english",
    });
  
  // Apply filters
  if (filters.domain) {
    queryBuilder = queryBuilder.eq("domain", filters.domain);
  }
  if (filters.country) {
    queryBuilder = queryBuilder.eq("country", filters.country);
  }
  if (filters.isMobile !== undefined) {
    queryBuilder = queryBuilder.eq("is_mobile", filters.isMobile);
  }
  if (filters.minFreshness) {
    queryBuilder = queryBuilder.gte("freshness_score", filters.minFreshness);
  }
  if (filters.language) {
    queryBuilder = queryBuilder.eq("language", filters.language);
  }
  
  queryBuilder = queryBuilder.limit(limit);
  
  const { data, error } = await queryBuilder;
  
  if (error) {
    logger.error("Keyword search failed", { error: error.message });
    throw new Error(`Keyword search failed: ${error.message}`);
  }
  
  return (data ?? []).map((row: any, index: number) => ({
    documentId: row.id,
    url: row.resolved_url,
    title: row.title,
    description: row.description,
    domain: row.domain,
    score: row.freshness_score * row.quality_score * (1 / (index + 1)),
    bm25Rank: index + 1,
    vectorRank: null,
    freshnessScore: row.freshness_score,
    qualityScore: row.quality_score,
    lastCrawledAt: row.last_crawled_at,
  }));
}

/**
 * Semantic-only search (vector similarity via Pinecone)
 */
async function semanticSearch(
  supabase: SupabaseClient,
  query: string,
  limit: number,
  filters: SearchFilters,
  logger: Logger,
): Promise<SearchResult[]> {
  if (!isEmbeddingEnabled() || !isPineconeEnabled()) {
    logger.warn("Embeddings or Pinecone not enabled, falling back to keyword search");
    return keywordSearch(supabase, query, limit, filters, logger);
  }
  
  // Generate query embedding
  const embResult = await generateEmbedding(query, {}, logger);
  const queryEmbedding = embResult.embedding;
  
  // Search Pinecone with filters
  const pineconeFilter = buildPineconeFilter(filters);
  const vectorResults = await searchPinecone(
    queryEmbedding,
    limit,
    pineconeFilter,
    "documents",
    logger,
  );
  
  if (vectorResults.length === 0) {
    return [];
  }
  
  // Get metadata from Postgres
  const docIds = vectorResults
    .map(r => r.metadata.doc_id)
    .filter(Boolean) as string[];
  
  const { data: metadata, error } = await supabase.rpc("get_documents_metadata", {
    doc_ids: docIds,
  });
  
  if (error) {
    logger.error("Failed to fetch metadata for semantic search", { error: error.message });
    throw new Error(`Metadata fetch failed: ${error.message}`);
  }
  
  // Create metadata map
  const metadataMap = new Map(
    (metadata || []).map((m: any) => [m.doc_id, m])
  );
  
  // Combine Pinecone results with Postgres metadata
  return vectorResults.map((result, index) => {
    const docId = result.metadata.doc_id || result.id;
    const meta: any = metadataMap.get(docId);
    
    if (!meta) {
      // Fallback to Pinecone metadata
      return {
        documentId: docId,
        url: result.metadata.url || "",
        title: result.metadata.title || null,
        description: null,
        domain: result.metadata.domain || "",
        score: result.score * (result.metadata.freshness_score || 1.0) * (result.metadata.quality_score || 1.0),
        bm25Rank: null,
        vectorRank: index + 1,
        freshnessScore: result.metadata.freshness_score || 1.0,
        qualityScore: result.metadata.quality_score || 1.0,
        lastCrawledAt: new Date().toISOString(),
      };
    }
    
    return {
      documentId: docId,
      url: meta.url,
      title: meta.title,
      description: meta.description,
      domain: meta.domain,
      score: result.score * meta.freshness_score * meta.quality_score,
      bm25Rank: null,
      vectorRank: index + 1,
      freshnessScore: meta.freshness_score,
      qualityScore: meta.quality_score,
      lastCrawledAt: meta.last_crawled_at,
    };
  }).filter(r => r.url !== "");
}

/**
 * Search within chunks (for precise snippet retrieval via Pinecone)
 */
export async function searchChunks(
  supabase: SupabaseClient,
  query: string,
  limit: number = 20,
  filters: SearchFilters = {},
  logger?: Logger,
): Promise<Array<{
  chunkId: string;
  documentId: string;
  url: string;
  title: string | null;
  text: string;
  score: number;
  ordinal: number;
}>> {
  const log = logger ?? _logger.child({ module: "search-chunks" });
  
  // Generate query embedding
  let queryEmbedding: number[] | null = null;
  
  if (isEmbeddingEnabled() && isPineconeEnabled()) {
    try {
      const embResult = await generateEmbedding(query, {}, log);
      queryEmbedding = embResult.embedding;
    } catch (error) {
      log.warn("Failed to generate query embedding for chunk search", {
        error: (error as Error).message,
      });
    }
  }
  
  if (!queryEmbedding) {
    // Fall back to keyword search on chunks (Postgres)
    const { data, error } = await supabase
      .from("search_chunks")
      .select("id, doc_id, text, ordinal")
      .textSearch("text_ts", query, {
        type: "plain",
        config: "english",
      })
      .not("text", "is", null)
      .limit(limit);
    
    if (error) {
      log.error("Chunk keyword search failed", { error: error.message });
      return [];
    }
    
    // Join with documents to get metadata
    const docIds = [...new Set((data ?? []).map(c => c.doc_id))];
    const { data: docsData } = await supabase
      .from("search_documents")
      .select("id, resolved_url, title")
      .in("id", docIds);
    
    const docMap = new Map((docsData ?? []).map(d => [d.id, d]));
    
    return (data ?? []).map((chunk, index) => {
      const doc = docMap.get(chunk.doc_id);
      return {
        chunkId: chunk.id,
        documentId: chunk.doc_id,
        url: doc?.resolved_url ?? "",
        title: doc?.title ?? null,
        text: chunk.text || "",
        score: 1 / (index + 1),
        ordinal: chunk.ordinal,
      };
    });
  }
  
  // Vector chunk search via Pinecone
  const pineconeFilter = buildPineconeFilter(filters);
  
  // Add chunk-specific filter
  const chunkFilter = {
    ...pineconeFilter,
    chunk_ordinal: { $exists: true }, // Only get chunk records, not document records
  };
  
  const vectorResults = await searchPinecone(
    queryEmbedding,
    limit,
    chunkFilter,
    "documents",
    log,
  );
  
  if (vectorResults.length === 0) {
    return [];
  }
  
  // Get chunk data from Postgres (for text and ordinal)
  const docIds = [...new Set(
    vectorResults.map(r => r.metadata.doc_id).filter(Boolean)
  )] as string[];
  
  const { data: chunksData } = await supabase
    .from("search_chunks")
    .select("id, doc_id, text, ordinal")
    .in("doc_id", docIds);
  
  const { data: docsData } = await supabase
    .from("search_documents")
    .select("id, resolved_url, title")
    .in("id", docIds);
  
  const chunkMap = new Map(
    (chunksData ?? [])
      .filter(c => c.doc_id && c.ordinal !== null)
      .map(c => [`${c.doc_id}_${c.ordinal}`, c])
  );
  const docMap = new Map((docsData ?? []).map(d => [d.id, d]));
  
  // Combine Pinecone results with Postgres data
  return vectorResults.map((result, index) => {
    const docId = result.metadata.doc_id;
    const ordinal = result.metadata.chunk_ordinal;
    const chunkKey = `${docId}_${ordinal}`;
    
    const chunk = chunkMap.get(chunkKey);
    const doc = docMap.get(docId);
    
    return {
      chunkId: result.id,
      documentId: docId || "",
      url: doc?.resolved_url || result.metadata.url || "",
      title: doc?.title || result.metadata.title || null,
      text: chunk?.text || "",
      score: result.score,
      ordinal: ordinal ?? 0,
    };
  }).filter(r => r.url !== "");
}

/**
 * Get search statistics (including Pinecone stats)
 */
export async function getSearchStats(
  supabase: SupabaseClient,
): Promise<{
  totalDocuments: number;
  totalChunks: number;
  documentsWithEmbeddings: number;
  chunksWithEmbeddings: number;
  avgFreshness: number;
  avgQuality: number;
  uniqueDomains: number;
  pineconeVectors?: number;
  pineconeIndexFullness?: number;
}> {
  const { data, error } = await supabase.from("search_index_stats").select("*");
  
  // Get Pinecone stats if available
  let pineconeStats = { vectorCount: 0, indexFullness: 0 };
  if (isPineconeEnabled()) {
    try {
      const { getPineconeStats } = await import("./pinecone-service.js");
      pineconeStats = await getPineconeStats("documents");
    } catch (error) {
      _logger.warn("Failed to get Pinecone stats", {
        error: (error as Error).message,
      });
    }
  }
  
  if (error || !data || data.length === 0) {
    return {
      totalDocuments: 0,
      totalChunks: 0,
      documentsWithEmbeddings: 0,
      chunksWithEmbeddings: 0,
      avgFreshness: 0,
      avgQuality: 0,
      uniqueDomains: 0,
      pineconeVectors: pineconeStats.vectorCount,
      pineconeIndexFullness: pineconeStats.indexFullness,
    };
  }
  
  const stats = data[0];
  return {
    totalDocuments: stats.total_documents ?? 0,
    totalChunks: stats.total_chunks ?? 0,
    documentsWithEmbeddings: stats.documents_in_pinecone ?? 0,
    chunksWithEmbeddings: stats.chunks_in_pinecone ?? 0,
    avgFreshness: stats.avg_freshness ?? 0,
    avgQuality: stats.avg_quality ?? 0,
    uniqueDomains: stats.unique_domains ?? 0,
    pineconeVectors: pineconeStats.vectorCount,
    pineconeIndexFullness: pineconeStats.indexFullness,
  };
}


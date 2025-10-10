import { Pinecone } from "@pinecone-database/pinecone";
import { logger as _logger } from "../logger";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "../otel-tracer";

// Pinecone client (singleton)
let pineconeClient: Pinecone | null = null;
let pineconeIndex: any = null;

/**
 * Initialize Pinecone client
 */
function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    const apiKey = process.env.PINECONE_API_KEY;
    
    if (!apiKey) {
      throw new Error("PINECONE_API_KEY not set");
    }
    
    pineconeClient = new Pinecone({
      apiKey,
    });
    
    _logger.info("Pinecone client initialized");
  }
  
  return pineconeClient;
}

/**
 * Get Pinecone index
 */
export function getPineconeIndex() {
  if (!pineconeIndex) {
    const client = getPineconeClient();
    const indexName = process.env.PINECONE_INDEX_NAME || "firecrawl-search";
    
    pineconeIndex = client.index(indexName);
    
    _logger.info("Pinecone index initialized", { indexName });
  }
  
  return pineconeIndex;
}

/**
 * Check if Pinecone is enabled
 * Note: PINECONE_INDEX_NAME is optional and defaults to "firecrawl-search" in getPineconeIndex()
 */
export function isPineconeEnabled(): boolean {
  return !!process.env.PINECONE_API_KEY;
}

export interface PineconeRecord {
  id: string;
  values: number[];
  metadata: {
    url: string;
    domain: string;
    title?: string;
    freshness_score: number;
    quality_score: number;
    country?: string;
    is_mobile: boolean;
    chunk_ordinal?: number; // For chunks
    doc_id?: string; // For chunks
  };
}

/**
 * Upsert embeddings to Pinecone
 */
export async function upsertToPinecone(
  records: PineconeRecord[],
  namespace: string = "documents",
  logger?: Logger,
): Promise<void> {
  return await withSpan("firecrawl-pinecone-upsert", async span => {
    const log = logger ?? _logger.child({ module: "pinecone-service" });
    
    setSpanAttributes(span, {
      "pinecone.operation": "upsert",
      "pinecone.namespace": namespace,
      "pinecone.record_count": records.length,
    });
    
    if (records.length === 0) {
      return;
    }
    
    try {
      const index = getPineconeIndex();
      const ns = index.namespace(namespace);
      
      // Upsert in batches of 100 (Pinecone limit)
      const batchSize = 100;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        
        await ns.upsert(batch);
        
        log.debug("Upserted batch to Pinecone", {
          batch: Math.floor(i / batchSize) + 1,
          size: batch.length,
        });
      }
      
      setSpanAttributes(span, {
        "pinecone.upsert_successful": true,
      });
      
      log.info("Upserted to Pinecone", {
        namespace,
        records: records.length,
      });
    } catch (error) {
      log.error("Failed to upsert to Pinecone", {
        error: (error as Error).message,
        namespace,
        recordCount: records.length,
      });
      
      setSpanAttributes(span, {
        "pinecone.upsert_error": true,
        "pinecone.error_message": (error as Error).message,
      });
      
      throw error;
    }
  });
}

/**
 * Search Pinecone for similar vectors
 */
export async function searchPinecone(
  queryEmbedding: number[],
  limit: number = 100,
  filter?: Record<string, any>,
  namespace: string = "documents",
  logger?: Logger,
): Promise<Array<{
  id: string;
  score: number;
  metadata: Record<string, any>;
}>> {
  return await withSpan("firecrawl-pinecone-query", async span => {
    const log = logger ?? _logger.child({ module: "pinecone-service" });
    
    setSpanAttributes(span, {
      "pinecone.operation": "query",
      "pinecone.namespace": namespace,
      "pinecone.limit": limit,
      "pinecone.has_filter": !!filter,
    });
    
    try {
      const index = getPineconeIndex();
      const ns = index.namespace(namespace);
      
      const queryResponse = await ns.query({
        vector: queryEmbedding,
        topK: limit,
        filter,
        includeMetadata: true,
        includeValues: false,
      });
      
      const results = (queryResponse.matches || []).map(match => ({
        id: match.id,
        score: match.score || 0,
        metadata: match.metadata || {},
      }));
      
      setSpanAttributes(span, {
        "pinecone.query_successful": true,
        "pinecone.results_count": results.length,
      });
      
      log.debug("Queried Pinecone", {
        namespace,
        limit,
        results: results.length,
      });
      
      return results;
    } catch (error) {
      log.error("Failed to query Pinecone", {
        error: (error as Error).message,
        namespace,
        limit,
      });
      
      setSpanAttributes(span, {
        "pinecone.query_error": true,
        "pinecone.error_message": (error as Error).message,
      });
      
      throw error;
    }
  });
}

/**
 * Delete from Pinecone
 */
export async function deleteFromPinecone(
  ids: string[],
  namespace: string = "documents",
  logger?: Logger,
): Promise<void> {
  const log = logger ?? _logger.child({ module: "pinecone-service" });
  
  try {
    const index = getPineconeIndex();
    const ns = index.namespace(namespace);
    
    await ns.deleteMany(ids);
    
    log.info("Deleted from Pinecone", {
      namespace,
      count: ids.length,
    });
  } catch (error) {
    log.error("Failed to delete from Pinecone", {
      error: (error as Error).message,
      namespace,
      count: ids.length,
    });
  }
}

/**
 * Get Pinecone index stats
 */
export async function getPineconeStats(
  namespace: string = "documents",
): Promise<{
  vectorCount: number;
  dimension: number;
  indexFullness: number;
}> {
  try {
    const index = getPineconeIndex();
    const stats = await index.describeIndexStats();
    
    const nsStats = stats.namespaces?.[namespace];
    
    return {
      vectorCount: nsStats?.recordCount || 0,
      dimension: stats.dimension || 1536,
      indexFullness: stats.indexFullness || 0,
    };
  } catch (error) {
    _logger.error("Failed to get Pinecone stats", {
      error: (error as Error).message,
    });
    
    return {
      vectorCount: 0,
      dimension: 1536,
      indexFullness: 0,
    };
  }
}

/**
 * Build Pinecone filter from search filters
 */
export function buildPineconeFilter(filters: {
  domain?: string;
  country?: string;
  isMobile?: boolean;
  minFreshness?: number;
}): Record<string, any> | undefined {
  const filter: Record<string, any> = {};
  
  if (filters.domain) {
    filter.domain = { $eq: filters.domain };
  }
  
  if (filters.country) {
    filter.country = { $eq: filters.country };
  }
  
  if (filters.isMobile !== undefined) {
    filter.is_mobile = { $eq: filters.isMobile };
  }
  
  if (filters.minFreshness !== undefined) {
    filter.freshness_score = { $gte: filters.minFreshness };
  }
  
  return Object.keys(filter).length > 0 ? filter : undefined;
}


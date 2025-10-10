import { SupabaseClient } from "@supabase/supabase-js";
import { logger as _logger } from "../logger";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "../otel-tracer";
import { 
  chunkText, 
  cleanMarkdownForIndexing, 
  estimateTokenCount,
  type TextChunk,
} from "./chunker";
import { 
  generateEmbedding, 
  generateEmbeddingsBatch,
  isEmbeddingEnabled,
  type EmbeddingResult,
} from "./embeddings";
import {
  upsertToPinecone,
  isPineconeEnabled,
  type PineconeRecord,
} from "./pinecone-service";
import crypto from "crypto";
import psl from "psl";

export interface SearchDocumentInput {
  url: string;
  resolvedUrl: string;
  title?: string;
  description?: string;
  markdown: string;
  html: string;
  statusCode: number;
  gcsPath?: string;
  screenshotUrl?: string;
  language?: string;
  country?: string;
  isMobile?: boolean;
}

export interface SearchIndexResult {
  documentId: string;
  chunkCount: number;
  totalTokens: number;
  embeddingsGenerated: boolean;
  error?: string;
}

/**
 * Main function: Index a document for search
 */
export async function indexDocumentForSearch(
  supabase: SupabaseClient,
  input: SearchDocumentInput,
  logger?: Logger,
): Promise<SearchIndexResult> {
  return await withSpan("firecrawl-index-document-for-search", async span => {
    const log = logger ?? _logger.child({ module: "search-index-service" });
    
    setSpanAttributes(span, {
      "search.url": input.url,
      "search.status_code": input.statusCode,
      "search.is_mobile": input.isMobile ?? false,
    });
    
    try {
      // 1. Extract and clean text from markdown
      const cleanText = cleanMarkdownForIndexing(input.markdown);
      
      if (!cleanText || cleanText.length < 100) {
        log.warn("Document too short to index", {
          url: input.url,
          textLength: cleanText.length,
        });
        return {
          documentId: "",
          chunkCount: 0,
          totalTokens: 0,
          embeddingsGenerated: false,
          error: "Document too short",
        };
      }
      
      setSpanAttributes(span, {
        "search.clean_text_length": cleanText.length,
        "search.clean_text_tokens": estimateTokenCount(cleanText),
      });
      
      // 2. Chunk the text
      const chunks = await chunkText(cleanText, {
        targetTokens: 750,
        minTokens: 600,
        maxTokens: 900,
        overlapTokens: 100,
        preserveStructure: true,
      }, log);
      
      if (chunks.length === 0) {
        log.warn("No chunks generated", { url: input.url });
        return {
          documentId: "",
          chunkCount: 0,
          totalTokens: 0,
          embeddingsGenerated: false,
          error: "No chunks generated",
        };
      }
      
      setSpanAttributes(span, {
        "search.chunk_count": chunks.length,
        "search.total_tokens": chunks.reduce((sum, c) => sum + c.tokenCount, 0),
      });
      
      // 3. Calculate URL hash and domain
      const urlHash = Buffer.from(
        crypto.createHash("sha256").update(normalizeSearchURL(input.url)).digest("hex"),
        "hex",
      );
      const domain = extractDomain(input.resolvedUrl);
      
      // 4. Generate embeddings (if enabled)
      const embeddingsEnabled = isEmbeddingEnabled() && isPineconeEnabled();
      let documentEmbedding: number[] | null = null;
      let chunkEmbeddings: number[][] = [];
      let totalTokens = 0;
      let pineconeRecords: PineconeRecord[] = [];
      let embeddingsActuallyGenerated = false;
      
      if (embeddingsEnabled) {
        try {
          // Generate document-level embedding (from title + description + first chunk)
          const documentText = [
            input.title,
            input.description,
            chunks[0]?.text.slice(0, 500),
          ]
            .filter(Boolean)
            .join(" ");
          
          const docEmbResult = await generateEmbedding(documentText, {}, log);
          documentEmbedding = docEmbResult.embedding;
          totalTokens += docEmbResult.tokens;
          
          // Generate chunk embeddings in batch
          const chunkTexts = chunks.map(c => c.text);
          const batchResult = await generateEmbeddingsBatch(chunkTexts, {
            batchSize: 50,
          }, log);
          
          chunkEmbeddings = batchResult.embeddings;
          totalTokens += batchResult.totalTokens;
          
          // Prepare Pinecone records (document + chunks)
          // Document-level record
          pineconeRecords.push({
            id: `doc_${crypto.randomUUID()}`,
            values: documentEmbedding,
            metadata: {
              url: input.resolvedUrl,
              domain: extractDomain(input.resolvedUrl),
              title: input.title,
              freshness_score: 1.0,
              quality_score: 1.0, // Will update later
              country: input.country,
              is_mobile: input.isMobile ?? false,
            },
          });
          
          // Chunk-level records
          chunks.forEach((chunk, i) => {
            if (chunkEmbeddings[i]) {
              pineconeRecords.push({
                id: `chunk_${crypto.randomUUID()}`,
                values: chunkEmbeddings[i],
                metadata: {
                  url: input.resolvedUrl,
                  domain: extractDomain(input.resolvedUrl),
                  title: input.title,
                  freshness_score: 1.0,
                  quality_score: 1.0,
                  country: input.country,
                  is_mobile: input.isMobile ?? false,
                  chunk_ordinal: i,
                  doc_id: "", // Will update after DB insert
                },
              });
            }
          });
          
          // Mark as successfully generated
          embeddingsActuallyGenerated = true;
          
          setSpanAttributes(span, {
            "search.embeddings_generated": true,
            "search.embedding_tokens": totalTokens,
            "search.pinecone_records": pineconeRecords.length,
          });
        } catch (error) {
          log.error("Failed to generate embeddings", {
            error: (error as Error).message,
            url: input.url,
          });
          setSpanAttributes(span, {
            "search.embeddings_error": true,
            "search.embeddings_error_message": (error as Error).message,
          });
          // Reset flag since embeddings failed
          embeddingsActuallyGenerated = false;
        }
      }
      
      // 5. Create tsvector for full-text search
      const contentTsVector = await createTsVector(supabase, cleanText);
      
      // 6. Upsert document into search_documents
      // Check if document already exists by url_hash
      // Note: url_hash is BYTEA, need to query with proper format
      const urlHashHex = "\\x" + urlHash.toString('hex');
      const { data: existingDocs, error: lookupError } = await supabase
        .from("search_documents")
        .select("id, content_hash")
        .eq("url_hash", urlHashHex)
        .limit(1);
      
      if (lookupError) {
        log.warn("Error looking up existing document, will attempt insert", {
          error: lookupError.message,
          url: input.url,
        });
      }
      
      const existingDoc = existingDocs?.[0];
      const newContentHash = Buffer.from(
        crypto.createHash("sha256").update(cleanText).digest("hex"),
        "hex",
      );
      
      let documentId: string;
      let isUpdate = false;
      
      if (existingDoc) {
        // Document exists - update it
        documentId = existingDoc.id;
        isUpdate = true;
        
        // Delete existing chunks (will be replaced)
        await supabase
          .from("search_chunks")
          .delete()
          .eq("doc_id", documentId);
        
        // Update document
        const { error: updateError } = await supabase
          .from("search_documents")
          .update({
            resolved_url: input.resolvedUrl,
            title: input.title?.slice(0, 200) ?? null,
            description: input.description?.slice(0, 500) ?? null,
            language: input.language ?? "en",
            gcs_path: input.gcsPath ?? null,
            screenshot_url: input.screenshotUrl ?? null,
            content_ts: contentTsVector,
            country: input.country ?? null,
            pinecone_synced: false, // Will sync after successful Pinecone upsert
            is_mobile: input.isMobile ?? false,
            status_code: input.statusCode,
            content_hash: newContentHash,
            freshness_score: 1.0, // Reset to fresh
            quality_score: calculateQualityScore(input, chunks),
            last_crawled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", documentId);
        
        if (updateError) {
          log.error("Failed to update document", {
            error: updateError.message,
            url: input.url,
            documentId,
          });
          
          setSpanAttributes(span, {
            "search.update_error": true,
            "search.update_error_message": updateError.message,
          });
          
          return {
            documentId: "",
            chunkCount: 0,
            totalTokens: 0,
            embeddingsGenerated: false,
            error: updateError.message,
          };
        }
      } else {
        // New document - insert
        documentId = crypto.randomUUID();
        
        const { error: insertError } = await supabase
          .from("search_documents")
          .insert({
            id: documentId,
            url_hash: urlHashHex,
            url: normalizeSearchURL(input.url),
            resolved_url: input.resolvedUrl,
            title: input.title?.slice(0, 200) ?? null,
            description: input.description?.slice(0, 500) ?? null,
            language: input.language ?? "en",
            gcs_path: input.gcsPath ?? null,
            gcp_path_id: input.gcsPath ?? null,
            screenshot_url: input.screenshotUrl ?? null,
            content_ts: contentTsVector,
            domain,
            country: input.country ?? null,
            is_mobile: input.isMobile ?? false,
            status_code: input.statusCode,
            content_hash: newContentHash,
            freshness_score: 1.0,
            quality_score: calculateQualityScore(input, chunks),
            last_crawled_at: new Date().toISOString(),
            pinecone_synced: false,
          });
        
        if (insertError) {
          log.error("Failed to insert document", {
            error: insertError.message,
            url: input.url,
          });
          
          setSpanAttributes(span, {
            "search.insert_error": true,
            "search.insert_error_message": insertError.message,
          });
          
          return {
            documentId: "",
            chunkCount: 0,
            totalTokens: 0,
            embeddingsGenerated: false,
            error: insertError.message,
          };
        }
      }
      
      // 7. Insert chunks into search_chunks
      // Only insert first 2 chunks for snippet display
      // Rest are stored only in Pinecone (saves 80% storage!)
      const chunkInserts = chunks
        .slice(0, 2) // Only first 2 chunks
        .map((chunk, i) => ({
          doc_id: documentId,
          ordinal: i,
          text: chunk.text,
          token_count: chunk.tokenCount,
          char_count: chunk.charCount,
          prev_chunk_id: null,
          pinecone_synced: false,
        }));
      
      const { error: chunkError } = await supabase
        .from("search_chunks")
        .insert(chunkInserts);
      
      if (chunkError) {
        log.error("Failed to insert chunks", {
          error: chunkError.message,
          url: input.url,
          documentId,
        });
        
        // Try to clean up the document
        await supabase.from("search_documents").delete().eq("id", documentId);
        
        return {
          documentId: "",
          chunkCount: 0,
          totalTokens: 0,
          embeddingsGenerated: false,
          error: chunkError.message,
        };
      }
      
      // 8. Upsert to Pinecone (async, don't block)
      if (embeddingsEnabled && pineconeRecords.length > 0) {
        // Update Pinecone records with actual doc_id
        pineconeRecords.forEach(record => {
          if (record.metadata.chunk_ordinal !== undefined) {
            record.metadata.doc_id = documentId;
          }
        });
        
        try {
          await upsertToPinecone(pineconeRecords, "documents", log);
          
          // Mark as synced
          await supabase
            .from("search_documents")
            .update({ 
              pinecone_synced: true,
              pinecone_synced_at: new Date().toISOString(),
            })
            .eq("id", documentId);
          
          await supabase
            .from("search_chunks")
            .update({ pinecone_synced: true })
            .eq("doc_id", documentId);
            
          log.info("Synced to Pinecone", {
            documentId,
            records: pineconeRecords.length,
          });
        } catch (error) {
          log.error("Failed to sync to Pinecone", {
            error: (error as Error).message,
            documentId,
          });
          // Continue anyway - can retry later
        }
      }
      
      // 9. Update sync state
      await updateSyncState(supabase, {
        documentsIndexed: 1,
        chunksIndexed: Math.min(chunks.length, 2), // Only inserted first 2
        embeddingsGenerated: embeddingsActuallyGenerated ? 1 + chunks.length : 0,
      });
      
      log.info("Document indexed successfully", {
        url: input.url,
        documentId,
        chunks: chunks.length,
        totalTokens,
        embeddingsGenerated: embeddingsActuallyGenerated,
        isUpdate,
      });
      
      setSpanAttributes(span, {
        "search.success": true,
        "search.document_id": documentId,
        "search.is_update": isUpdate,
      });
      
      return {
        documentId,
        chunkCount: chunks.length,
        totalTokens,
        embeddingsGenerated: embeddingsActuallyGenerated,
      };
    } catch (error) {
      log.error("Failed to index document", {
        error: (error as Error).message,
        url: input.url,
      });
      
      setSpanAttributes(span, {
        "search.error": true,
        "search.error_message": (error as Error).message,
      });
      
      return {
        documentId: "",
        chunkCount: 0,
        totalTokens: 0,
        embeddingsGenerated: false,
        error: (error as Error).message,
      };
    }
  });
}

/**
 * Normalize URL for search index (remove query params, fragments, etc.)
 * Preserves the original protocol (http/https) to avoid collisions and maintain reachability
 */
function normalizeSearchURL(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.hash = "";
    urlObj.search = ""; // Remove query params for canonical URL
    // Note: Preserve original protocol (don't force https) to avoid:
    // 1. Making HTTP-only pages unreachable
    // 2. Collisions between distinct HTTP/HTTPS resources
    
    if (urlObj.hostname.startsWith("www.")) {
      urlObj.hostname = urlObj.hostname.slice(4);
    }
    
    if (urlObj.pathname.endsWith("/")) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    const parsed = psl.parse(urlObj.hostname);
    
    if (parsed.domain) {
      return parsed.domain;
    }
    
    return urlObj.hostname;
  } catch {
    return "";
  }
}

/**
 * Calculate quality score based on content characteristics
 */
function calculateQualityScore(
  input: SearchDocumentInput,
  chunks: TextChunk[],
): number {
  let score = 1.0;
  
  // Factor 1: Has title and description
  if (input.title && input.title.length > 10) score *= 1.1;
  if (input.description && input.description.length > 50) score *= 1.1;
  
  // Factor 2: Content length (sweet spot: 2000-10000 chars)
  const totalChars = chunks.reduce((sum, c) => sum + c.charCount, 0);
  if (totalChars >= 2000 && totalChars <= 10000) {
    score *= 1.2;
  } else if (totalChars < 500) {
    score *= 0.5;
  } else if (totalChars > 50000) {
    score *= 0.8;
  }
  
  // Factor 3: Chunk count (good chunking indicates structured content)
  if (chunks.length >= 3 && chunks.length <= 20) {
    score *= 1.1;
  }
  
  // Factor 4: Status code
  if (input.statusCode >= 200 && input.statusCode < 300) {
    score *= 1.0;
  } else {
    score *= 0.3;
  }
  
  // Normalize to [0, 1]
  return Math.min(Math.max(score, 0.1), 2.0);
}

/**
 * Create tsvector from text (for BM25 search)
 */
async function createTsVector(
  supabase: SupabaseClient,
  text: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("to_tsvector_english", {
      text: text.slice(0, 100000), // Limit to 100k chars
    });
    
    if (error) {
      _logger.warn("Failed to create tsvector", { error: error.message });
      return null;
    }
    
    return data;
  } catch (error) {
    _logger.warn("Failed to create tsvector", {
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Update sync state with metrics
 */
async function updateSyncState(
  supabase: SupabaseClient,
  metrics: {
    documentsIndexed?: number;
    chunksIndexed?: number;
    embeddingsGenerated?: number;
    failedDocuments?: number;
  },
): Promise<void> {
  try {
    const updates: any = {
      updated_at: new Date().toISOString(),
    };
    
    if (metrics.documentsIndexed) {
      // Use SQL to increment
      await supabase.rpc("increment_search_sync_state", {
        field: "total_documents_indexed",
        amount: metrics.documentsIndexed,
      });
    }
    
    if (metrics.chunksIndexed) {
      await supabase.rpc("increment_search_sync_state", {
        field: "total_chunks_indexed",
        amount: metrics.chunksIndexed,
      });
    }
    
    if (metrics.failedDocuments) {
      await supabase.rpc("increment_search_sync_state", {
        field: "failed_documents",
        amount: metrics.failedDocuments,
      });
    }
    
    // Update embedding quota tracking
    const today = new Date().toISOString().split("T")[0];
    await supabase.rpc("update_embedding_quota", {
      embeddings_count: metrics.embeddingsGenerated ?? 0,
      today_date: today,
    });
  } catch (error) {
    _logger.warn("Failed to update sync state", {
      error: (error as Error).message,
    });
  }
}

/**
 * Delete document from search index
 */
export async function deleteDocumentFromSearch(
  supabase: SupabaseClient,
  urlHash: Buffer,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? _logger.child({ module: "search-index-service" });
  
  try {
    const urlHashHex = "\\x" + urlHash.toString('hex');
    const { error } = await supabase
      .from("search_documents")
      .delete()
      .eq("url_hash", urlHashHex);
    
    if (error) {
      log.error("Failed to delete document from search index", {
        error: error.message,
      });
    }
  } catch (error) {
    log.error("Failed to delete document from search index", {
      error: (error as Error).message,
    });
  }
}

/**
 * Check if document already exists in search index
 */
export async function searchDocumentExists(
  supabase: SupabaseClient,
  urlHash: Buffer,
): Promise<boolean> {
  try {
    const urlHashHex = "\\x" + urlHash.toString('hex');
    const { data, error } = await supabase
      .from("search_documents")
      .select("id")
      .eq("url_hash", urlHashHex)
      .limit(1);
    
    if (error) return false;
    
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}


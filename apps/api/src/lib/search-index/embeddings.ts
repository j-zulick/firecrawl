import { embed, EmbeddingModel } from "ai";
import { getEmbeddingModel } from "../generic-ai";
import { logger as _logger } from "../logger";
import type { Logger } from "winston";
import { withSpan, setSpanAttributes } from "../otel-tracer";

export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  totalTokens: number;
  failed: number[];
}

export interface EmbeddingOptions {
  model?: string;
  dimensions?: number;
  maxRetries?: number;
  retryDelay?: number;
  batchSize?: number;
}

const DEFAULT_OPTIONS: Required<EmbeddingOptions> = {
  model: "text-embedding-3-small",
  dimensions: 1536,
  maxRetries: 3,
  retryDelay: 1000, // ms
  batchSize: 100,
};

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
  options: EmbeddingOptions = {},
  logger?: Logger,
): Promise<EmbeddingResult> {
  return await withSpan("firecrawl-generate-embedding", async span => {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const log = logger ?? _logger.child({ module: "search-embeddings" });
    
    setSpanAttributes(span, {
      "embedding.model": opts.model,
      "embedding.dimensions": opts.dimensions,
      "embedding.text_length": text.length,
    });
    
    if (!text || text.trim().length === 0) {
      setSpanAttributes(span, { "embedding.empty_text": true });
      return {
        embedding: new Array(opts.dimensions).fill(0),
        tokens: 0,
      };
    }
    
    // Truncate if too long (OpenAI limit: 8191 tokens for text-embedding-3-small)
    const maxChars = 8191 * 4; // Rough approximation
    const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
      try {
        const embeddingModel: EmbeddingModel<string> = getEmbeddingModel(
          opts.model,
          "openai",
        );
        
        const result = await embed({
          model: embeddingModel,
          value: truncatedText,
        });
        
        setSpanAttributes(span, {
          "embedding.success": true,
          "embedding.tokens": result.usage.tokens,
          "embedding.attempt": attempt + 1,
        });
        
        log.debug("Generated embedding", {
          textLength: text.length,
          tokens: result.usage.tokens,
          dimensions: result.embedding.length,
        });
        
        return {
          embedding: result.embedding,
          tokens: result.usage.tokens,
        };
      } catch (error) {
        lastError = error as Error;
        
        setSpanAttributes(span, {
          "embedding.error": true,
          "embedding.attempt": attempt + 1,
          "embedding.error_message": lastError.message,
        });
        
        log.warn("Failed to generate embedding", {
          error: lastError.message,
          attempt: attempt + 1,
          maxRetries: opts.maxRetries,
        });
        
        // Exponential backoff
        if (attempt < opts.maxRetries - 1) {
          const delay = opts.retryDelay * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    log.error("Failed to generate embedding after all retries", {
      error: lastError?.message,
      maxRetries: opts.maxRetries,
    });
    
    // Return zero vector as fallback
    return {
      embedding: new Array(opts.dimensions).fill(0),
      tokens: 0,
    };
  });
}

/**
 * Generate embeddings for multiple texts in batches
 * More efficient for bulk operations
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  options: EmbeddingOptions = {},
  logger?: Logger,
): Promise<BatchEmbeddingResult> {
  return await withSpan("firecrawl-generate-embeddings-batch", async span => {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const log = logger ?? _logger.child({ module: "search-embeddings-batch" });
    
    setSpanAttributes(span, {
      "embedding.batch_size": texts.length,
      "embedding.model": opts.model,
    });
    
    if (texts.length === 0) {
      return {
        embeddings: [],
        totalTokens: 0,
        failed: [],
      };
    }
    
    const embeddings: number[][] = new Array(texts.length);
    const failed: number[] = [];
    let totalTokens = 0;
    
    // Process in batches
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += opts.batchSize) {
      batches.push(texts.slice(i, i + opts.batchSize));
    }
    
    log.info("Processing embedding batches", {
      totalTexts: texts.length,
      batches: batches.length,
      batchSize: opts.batchSize,
    });
    
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchOffset = batchIndex * opts.batchSize;
      
      log.debug("Processing batch", {
        batch: batchIndex + 1,
        total: batches.length,
        size: batch.length,
      });
      
      // Process batch items in parallel
      const batchResults = await Promise.allSettled(
        batch.map((text, i) => 
          generateEmbedding(text, options, log).then(result => ({
            index: batchOffset + i,
            ...result,
          }))
        ),
      );
      
      // Collect results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          const { index, embedding, tokens } = result.value;
          embeddings[index] = embedding;
          totalTokens += tokens;
        } else {
          const index = batchOffset + batchResults.indexOf(result);
          failed.push(index);
          embeddings[index] = new Array(opts.dimensions).fill(0);
          
          log.warn("Failed to generate embedding in batch", {
            index,
            error: result.reason?.message,
          });
        }
      }
      
      // Rate limiting: small delay between batches
      if (batchIndex < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    setSpanAttributes(span, {
      "embedding.total_tokens": totalTokens,
      "embedding.failed_count": failed.length,
      "embedding.success_rate": ((texts.length - failed.length) / texts.length),
    });
    
    log.info("Batch embedding complete", {
      total: texts.length,
      successful: texts.length - failed.length,
      failed: failed.length,
      totalTokens,
    });
    
    return {
      embeddings,
      totalTokens,
      failed,
    };
  });
}

/**
 * Estimate embedding cost for text
 * Based on OpenAI pricing: $0.02 / 1M tokens
 */
export function estimateEmbeddingCost(tokenCount: number): number {
  return (tokenCount / 1_000_000) * 0.02;
}

/**
 * Check if embeddings are available (API key configured)
 */
export function isEmbeddingEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Normalize embedding vector (convert to unit vector)
 * Useful for cosine similarity when using dot product
 */
export function normalizeEmbedding(embedding: number[]): number[] {
  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0),
  );
  
  if (magnitude === 0) return embedding;
  
  return embedding.map(val => val / magnitude);
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have the same dimensions");
  }
  
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  
  return dotProduct / (magnitudeA * magnitudeB);
}


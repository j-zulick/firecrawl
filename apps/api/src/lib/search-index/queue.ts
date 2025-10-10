/**
 * Search Index Queue Processor
 * 
 * Handles async indexing jobs using Redis queue.
 * Similar to existing index insert queue, but for search index.
 * 
 * Flow:
 * 1. Scraper adds job to queue after successful scrape
 * 2. Background worker picks up jobs in batches
 * 3. Text is chunked and embeddings generated
 * 4. Data is written to search_documents and search_chunks
 */

import { redisEvictConnection } from "../../services/redis";
import { logger as _logger } from "../logger";
import { indexDocumentForSearch, type SearchDocumentInput } from "./service";
import { search_index_supabase_service } from "../../services/search-index-db";

const SEARCH_INDEX_QUEUE_KEY = "search-index-queue";
const SEARCH_INDEX_BATCH_SIZE = 10; // Smaller batch size due to embedding generation

export interface SearchIndexJob {
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

/**
 * Add a job to the search index queue
 */
export async function addSearchIndexJob(job: SearchIndexJob): Promise<void> {
  try {
    await redisEvictConnection.rpush(
      SEARCH_INDEX_QUEUE_KEY,
      JSON.stringify(job),
    );
    
    _logger.debug("Added job to search index queue", {
      url: job.url,
    });
  } catch (error) {
    _logger.error("Failed to add job to search index queue", {
      error: (error as Error).message,
      url: job.url,
    });
  }
}

/**
 * Get jobs from the queue
 */
async function getSearchIndexJobs(): Promise<SearchIndexJob[]> {
  try {
    const jobs =
      (await redisEvictConnection.lpop(
        SEARCH_INDEX_QUEUE_KEY,
        SEARCH_INDEX_BATCH_SIZE,
      )) ?? [];
    
    return jobs.map(x => JSON.parse(x) as SearchIndexJob);
  } catch (error) {
    _logger.error("Failed to get jobs from search index queue", {
      error: (error as Error).message,
    });
    return [];
  }
}

/**
 * Process search index jobs (called by background worker)
 */
export async function processSearchIndexJobs(): Promise<void> {
  const jobs = await getSearchIndexJobs();
  
  if (jobs.length === 0) {
    return;
  }
  
  _logger.info("Processing search index jobs", {
    jobCount: jobs.length,
  });
  
  let successCount = 0;
  let failedCount = 0;
  
  // Process jobs sequentially to avoid overwhelming embedding API
  for (const job of jobs) {
    try {
      const logger = _logger.child({
        module: "search-index-queue",
        url: job.url,
      });
      
      const result = await indexDocumentForSearch(
        search_index_supabase_service,
        {
          url: job.url,
          resolvedUrl: job.resolvedUrl,
          title: job.title,
          description: job.description,
          markdown: job.markdown,
          html: job.html,
          statusCode: job.statusCode,
          gcsPath: job.gcsPath,
          screenshotUrl: job.screenshotUrl,
          language: job.language,
          country: job.country,
          isMobile: job.isMobile,
        },
        logger,
      );
      
      if (result.error) {
        failedCount++;
        logger.error("Failed to index document for search", {
          error: result.error,
        });
      } else {
        successCount++;
        logger.info("Indexed document for search", {
          documentId: result.documentId,
          chunks: result.chunkCount,
          tokens: result.totalTokens,
        });
      }
    } catch (error) {
      failedCount++;
      _logger.error("Failed to process search index job", {
        error: (error as Error).message,
        url: job.url,
      });
    }
  }
  
  _logger.info("Finished processing search index jobs", {
    total: jobs.length,
    successful: successCount,
    failed: failedCount,
  });
}

/**
 * Get queue length
 */
export async function getSearchIndexQueueLength(): Promise<number> {
  try {
    return (await redisEvictConnection.llen(SEARCH_INDEX_QUEUE_KEY)) ?? 0;
  } catch (error) {
    _logger.error("Failed to get search index queue length", {
      error: (error as Error).message,
    });
    return 0;
  }
}


/**
 * Search Index Module
 * 
 * Real-time search index on top of Firecrawl's web scraping infrastructure.
 * Combines keyword (BM25) and semantic (vector) search with RRF ranking.
 * 
 * 
 * Architecture:
 * - Ingest: Crawler → Text Normalization → Chunking → Embeddings → Postgres
 * - Query: Hybrid Search (BM25 + Vector) → RRF → Filters → Results
 * - Storage: search_documents + search_chunks tables
 * - Embeddings: OpenAI text-embedding-3-small (1536 dims)
 */

export {
  chunkText,
  cleanMarkdownForIndexing,
  estimateTokenCount,
  type TextChunk,
  type ChunkingOptions,
} from "./chunker";

export {
  generateEmbedding,
  generateEmbeddingsBatch,
  isEmbeddingEnabled,
  estimateEmbeddingCost,
  normalizeEmbedding,
  cosineSimilarity,
  type EmbeddingResult,
  type BatchEmbeddingResult,
  type EmbeddingOptions,
} from "./embeddings";

export {
  indexDocumentForSearch,
  deleteDocumentFromSearch,
  searchDocumentExists,
  type SearchDocumentInput,
  type SearchIndexResult,
} from "./service";

export {
  search,
  searchChunks,
  getSearchStats,
  type SearchQuery,
  type SearchFilters,
  type SearchResult,
  type SearchResponse,
} from "./query";

export {
  addSearchIndexJob,
  processSearchIndexJobs,
  getSearchIndexQueueLength,
} from "./queue";

export {
  upsertToPinecone,
  searchPinecone,
  deleteFromPinecone,
  getPineconeStats,
  isPineconeEnabled,
  buildPineconeFilter,
  getPineconeIndex,
  type PineconeRecord,
} from "./pinecone-service";


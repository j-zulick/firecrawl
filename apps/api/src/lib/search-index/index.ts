
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


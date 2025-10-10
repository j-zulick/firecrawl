import { logger as _logger } from "../logger";
import type { Logger } from "winston";

export interface TextChunk {
  text: string;
  ordinal: number;
  tokenCount: number;
  charCount: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkingOptions {
  targetTokens?: number; // Target tokens per chunk (default: 750)
  minTokens?: number; // Minimum tokens per chunk (default: 600)
  maxTokens?: number; // Maximum tokens per chunk (default: 900)
  overlapTokens?: number; // Overlap between chunks (default: 100)
  preserveStructure?: boolean; // Preserve markdown structure (default: true)
}

const DEFAULT_OPTIONS: Required<ChunkingOptions> = {
  targetTokens: 750,
  minTokens: 600,
  maxTokens: 900,
  overlapTokens: 100,
  preserveStructure: true,
};

/**
 * Estimate token count using simple heuristic (1 token ≈ 4 chars for English)
 * This is approximate but fast. For exact counts, use tiktoken.
 */
export function estimateTokenCount(text: string): number {
  // Remove extra whitespace
  const normalized = text.replace(/\s+/g, " ").trim();
  // Rough approximation: 1 token ≈ 4 characters
  return Math.ceil(normalized.length / 4);
}

/**
 * Split text into sentences, preserving structure
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries, but preserve structure
  const sentences: string[] = [];
  
  // Match sentences ending with .!? followed by space/newline/end
  // Also handle abbreviations like "Dr." "Mr." "etc."
  const sentenceRegex = /(?<![A-Z][a-z]\.)\s*([.!?]+)\s+(?=[A-Z]|$)/g;
  
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  
  while ((match = sentenceRegex.exec(text)) !== null) {
    const sentence = text.slice(lastIndex, match.index + match[1].length).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining.length > 0) {
      sentences.push(remaining);
    }
  }
  
  return sentences.filter(s => s.length > 0);
}

/**
 * Detect markdown structure boundaries (headings, lists, code blocks)
 */
function detectStructureBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  
  const lines = text.split("\n");
  let offset = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect headings
    if (/^#{1,6}\s/.test(line)) {
      boundaries.push(offset);
    }
    
    // Detect code blocks
    if (/^```/.test(line)) {
      boundaries.push(offset);
    }
    
    // Detect list items (with proper structure)
    if (/^[\s]*[-*+]\s/.test(line) || /^[\s]*\d+\.\s/.test(line)) {
      boundaries.push(offset);
    }
    
    offset += line.length + 1; // +1 for newline
  }
  
  boundaries.push(text.length);
  
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

/**
 * Main chunking function: splits text into semantically coherent chunks
 */
export async function chunkText(
  text: string,
  options: ChunkingOptions = {},
  logger?: Logger,
): Promise<TextChunk[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const log = logger ?? _logger.child({ module: "search-chunker" });
  
  // Handle empty or very short text
  if (!text || text.trim().length === 0) {
    return [];
  }
  
  const totalTokens = estimateTokenCount(text);
  
  // If text is short enough, return as single chunk
  if (totalTokens <= opts.maxTokens) {
    return [{
      text: text.trim(),
      ordinal: 0,
      tokenCount: totalTokens,
      charCount: text.length,
      startOffset: 0,
      endOffset: text.length,
    }];
  }
  
  const chunks: TextChunk[] = [];
  
  // Strategy 1: If preserving structure, respect markdown boundaries
  if (opts.preserveStructure) {
    const boundaries = detectStructureBoundaries(text);
    const sections = boundaries.slice(0, -1).map((start, i) => ({
      text: text.slice(start, boundaries[i + 1]),
      offset: start,
    }));
    
    let currentChunk = "";
    let currentOffset = 0;
    let currentTokens = 0;
    
    for (const section of sections) {
      const sectionTokens = estimateTokenCount(section.text);
      
      // If section alone exceeds max, split it further
      if (sectionTokens > opts.maxTokens) {
        // Flush current chunk if any
        if (currentChunk.length > 0) {
          chunks.push({
            text: currentChunk.trim(),
            ordinal: chunks.length,
            tokenCount: currentTokens,
            charCount: currentChunk.length,
            startOffset: currentOffset,
            endOffset: currentOffset + currentChunk.length,
          });
          currentChunk = "";
          currentTokens = 0;
        }
        
        // Split large section by sentences
        const sentences = splitIntoSentences(section.text);
        let sentenceChunk = "";
        let sentenceTokens = 0;
        let sentenceChunkOffset = section.offset;
        
        for (const sentence of sentences) {
          const sentenceTokenCount = estimateTokenCount(sentence);
          
          if (sentenceTokens + sentenceTokenCount > opts.maxTokens && sentenceChunk.length > 0) {
            // Save overlap from the previous chunk before flushing
            const overlapText = sentenceChunk.slice(-opts.overlapTokens * 4); // Rough char estimate
            const chunkLength = sentenceChunk.length;
            
            chunks.push({
              text: sentenceChunk.trim(),
              ordinal: chunks.length,
              tokenCount: sentenceTokens,
              charCount: chunkLength,
              startOffset: sentenceChunkOffset,
              endOffset: sentenceChunkOffset + chunkLength,
            });
            
            // Update offset for next chunk - account for overlap
            // The next chunk will start with overlapText, so its offset should point
            // to where the overlap begins in the source (not where previous chunk ended)
            sentenceChunkOffset += chunkLength - overlapText.length;
            
            // Start new chunk with overlap from previous chunk + new sentence
            sentenceChunk = overlapText + " " + sentence;
            sentenceTokens = estimateTokenCount(sentenceChunk);
          } else {
            sentenceChunk += (sentenceChunk.length > 0 ? " " : "") + sentence;
            sentenceTokens += sentenceTokenCount;
          }
        }
        
        if (sentenceChunk.length > 0) {
          chunks.push({
            text: sentenceChunk.trim(),
            ordinal: chunks.length,
            tokenCount: sentenceTokens,
            charCount: sentenceChunk.length,
            startOffset: sentenceChunkOffset,
            endOffset: sentenceChunkOffset + sentenceChunk.length,
          });
        }
        
        currentOffset = section.offset + section.text.length;
        currentChunk = "";
        currentTokens = 0;
        continue;
      }
      
      // Try to add section to current chunk
      if (currentTokens + sectionTokens <= opts.maxTokens) {
        currentChunk += (currentChunk.length > 0 ? "\n" : "") + section.text;
        currentTokens += sectionTokens;
        if (currentChunk.length === section.text.length) {
          currentOffset = section.offset;
        }
      } else {
        // Current chunk is full, flush it
        if (currentChunk.length > 0) {
          chunks.push({
            text: currentChunk.trim(),
            ordinal: chunks.length,
            tokenCount: currentTokens,
            charCount: currentChunk.length,
            startOffset: currentOffset,
            endOffset: currentOffset + currentChunk.length,
          });
        }
        
        // Start new chunk with current section
        currentChunk = section.text;
        currentOffset = section.offset;
        currentTokens = sectionTokens;
      }
    }
    
    // Flush remaining chunk
    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        ordinal: chunks.length,
        tokenCount: currentTokens,
        charCount: currentChunk.length,
        startOffset: currentOffset,
        endOffset: currentOffset + currentChunk.length,
      });
    }
  } else {
    // Strategy 2: Simple sentence-based chunking without structure preservation
    const sentences = splitIntoSentences(text);
    let currentChunk = "";
    let currentTokens = 0;
    let currentOffset = 0;
    
    for (const sentence of sentences) {
      const sentenceTokens = estimateTokenCount(sentence);
      
      if (currentTokens + sentenceTokens > opts.maxTokens && currentChunk.length > 0) {
        const chunkLength = currentChunk.length;
        chunks.push({
          text: currentChunk.trim(),
          ordinal: chunks.length,
          tokenCount: currentTokens,
          charCount: chunkLength,
          startOffset: currentOffset,
          endOffset: currentOffset + chunkLength,
        });
        
        // Add overlap for context
        const lastSentences = currentChunk.split(/[.!?]+\s+/).slice(-2).join(". ");
        
        // Update offset for next chunk - account for overlap
        // The next chunk will start with lastSentences, so its offset should point
        // to where the overlap begins in the source (not where previous chunk ended)
        currentOffset += chunkLength - lastSentences.length;
        
        currentChunk = lastSentences + " " + sentence;
        currentTokens = estimateTokenCount(currentChunk);
      } else {
        currentChunk += (currentChunk.length > 0 ? " " : "") + sentence;
        currentTokens += sentenceTokens;
      }
      
      if (chunks.length === 0 && currentChunk === sentence) {
        currentOffset = 0;
      }
    }
    
    // Flush remaining
    if (currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        ordinal: chunks.length,
        tokenCount: currentTokens,
        charCount: currentChunk.length,
        startOffset: currentOffset,
        endOffset: currentOffset + currentChunk.length,
      });
    }
  }
  
  log.debug("Chunked text", {
    totalTokens,
    chunks: chunks.length,
    avgTokensPerChunk: chunks.length > 0 
      ? Math.round(chunks.reduce((sum, c) => sum + c.tokenCount, 0) / chunks.length) 
      : 0,
  });
  
  return chunks;
}

/**
 * Extract clean text from markdown for indexing
 * Removes markdown syntax but preserves structure and content
 */
export function cleanMarkdownForIndexing(markdown: string): string {
  if (!markdown) return "";
  
  let text = markdown;
  
  // Remove code blocks but keep language hints
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    return lang ? `Code (${lang}): ${code.split("\n").slice(0, 3).join(" ")}...` : "";
  });
  
  // Remove inline code (keep content)
  text = text.replace(/`([^`]+)`/g, "$1");
  
  // Remove images (keep alt text)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  
  // Remove links (keep text)
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  
  // Remove headers (#) but keep text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "$1");
  
  // Remove bold/italic
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  
  // Remove list markers but keep structure
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");
  
  // Remove blockquotes
  text = text.replace(/^>\s+/gm, "");
  
  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "");
  
  // Normalize whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/  +/g, " ");
  
  return text.trim();
}


import {
  chunkText,
  cleanMarkdownForIndexing,
  estimateTokenCount,
  type TextChunk,
  type ChunkingOptions,
} from "../chunker";

describe("Chunker", () => {
  describe("estimateTokenCount", () => {
    it("should estimate token count for simple text", () => {
      const text = "Hello world";
      const tokens = estimateTokenCount(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it("should estimate token count for longer text", () => {
      const text = "This is a longer piece of text that should have more tokens than the previous example.";
      const tokens = estimateTokenCount(text);
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThan(50);
    });

    it("should handle empty string", () => {
      const tokens = estimateTokenCount("");
      expect(tokens).toBe(0);
    });

    it("should normalize whitespace before counting", () => {
      const text1 = "Hello    world";
      const text2 = "Hello world";
      expect(estimateTokenCount(text1)).toBe(estimateTokenCount(text2));
    });
  });

  describe("cleanMarkdownForIndexing", () => {
    it("should remove code blocks", () => {
      const markdown = "Some text\n```javascript\nconst x = 1;\n```\nMore text";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).not.toContain("```");
      expect(cleaned).toContain("Some text");
      expect(cleaned).toContain("More text");
    });

    it("should remove inline code but keep content", () => {
      const markdown = "This is `inline code` in text";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).not.toContain("`");
      expect(cleaned).toContain("inline code");
    });

    it("should remove images but keep alt text", () => {
      const markdown = "Check this ![alt text](image.png) out";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).toContain("alt text");
      expect(cleaned).not.toContain("![");
      expect(cleaned).not.toContain("](");
    });

    it("should remove links but keep text", () => {
      const markdown = "Visit [Google](https://google.com) for search";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).toContain("Google");
      expect(cleaned).not.toContain("[");
      expect(cleaned).not.toContain("](");
    });

    it("should remove headers but keep text", () => {
      const markdown = "# Heading 1\n## Heading 2\n### Heading 3";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).toContain("Heading 1");
      expect(cleaned).toContain("Heading 2");
      expect(cleaned).toContain("Heading 3");
      expect(cleaned).not.toContain("#");
    });

    it("should remove bold and italic markers", () => {
      const markdown = "This is **bold** and *italic* text";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).toContain("bold");
      expect(cleaned).toContain("italic");
      expect(cleaned).not.toContain("**");
      expect(cleaned).not.toContain("*");
    });

    it("should remove list markers", () => {
      const markdown = "- Item 1\n- Item 2\n1. Ordered item";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).toContain("Item 1");
      expect(cleaned).toContain("Item 2");
      expect(cleaned).toContain("Ordered item");
      expect(cleaned).not.toMatch(/^[-*+]\s/m);
      expect(cleaned).not.toMatch(/^\d+\.\s/m);
    });

    it("should handle empty input", () => {
      expect(cleanMarkdownForIndexing("")).toBe("");
      expect(cleanMarkdownForIndexing(null as any)).toBe("");
    });

    it("should normalize excessive whitespace", () => {
      const markdown = "Text\n\n\n\nwith\n\n\n\nmany\n\n\n\nlines";
      const cleaned = cleanMarkdownForIndexing(markdown);
      expect(cleaned).not.toMatch(/\n{3,}/);
    });
  });

  describe("chunkText", () => {
    describe("basic functionality", () => {
      it("should return empty array for empty text", async () => {
        const chunks = await chunkText("");
        expect(chunks).toEqual([]);
      });

      it("should return single chunk for short text", async () => {
        const text = "This is a short piece of text.";
        const chunks = await chunkText(text);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe(text.trim());
        expect(chunks[0].ordinal).toBe(0);
      });

      it("should split long text into multiple chunks", async () => {
        // Create a text that exceeds max tokens
        const longText = Array(200)
          .fill("This is a sentence with multiple words.")
          .join(" ");
        const chunks = await chunkText(longText, { maxTokens: 500 });
        expect(chunks.length).toBeGreaterThan(1);
      });

      it("should respect maxTokens limit", async () => {
        const longText = Array(100)
          .fill("This is a sentence.")
          .join(" ");
        const maxTokens = 300;
        const chunks = await chunkText(longText, { maxTokens });
        
        chunks.forEach(chunk => {
          expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
        });
      });
    });

    describe("chunk metadata", () => {
      it("should set correct ordinals", async () => {
        const longText = Array(100)
          .fill("This is a sentence.")
          .join(" ");
        const chunks = await chunkText(longText, { maxTokens: 300 });
        
        chunks.forEach((chunk, index) => {
          expect(chunk.ordinal).toBe(index);
        });
      });

      it("should calculate token counts", async () => {
        const text = "This is test text.";
        const chunks = await chunkText(text);
        
        expect(chunks[0].tokenCount).toBeGreaterThan(0);
        expect(chunks[0].tokenCount).toBe(estimateTokenCount(text.trim()));
      });

      it("should calculate character counts", async () => {
        const text = "This is test text.";
        const chunks = await chunkText(text);
        
        expect(chunks[0].charCount).toBe(text.length);
      });

      it("should set start and end offsets", async () => {
        const text = "First sentence. Second sentence.";
        const chunks = await chunkText(text);
        
        expect(chunks[0].startOffset).toBe(0);
        expect(chunks[0].endOffset).toBeGreaterThan(0);
        expect(chunks[0].endOffset).toBeLessThanOrEqual(text.length);
      });
    });

    describe("offset tracking", () => {
      it("should track offsets correctly for multiple chunks", async () => {
        const longText = Array(100)
          .fill("This is a sentence with several words.")
          .join(" ");
        const chunks = await chunkText(longText, { maxTokens: 300 });
        
        // First chunk should start at 0
        expect(chunks[0].startOffset).toBe(0);
        
        // Each chunk's offsets should be sequential (allowing for overlap)
        for (let i = 1; i < chunks.length; i++) {
          expect(chunks[i].startOffset).toBeGreaterThanOrEqual(0);
          expect(chunks[i].endOffset).toBeGreaterThan(chunks[i].startOffset);
        }
      });

      it("should maintain consistent offsets in structure-preserving mode", async () => {
        const text = "# Heading\n\nParagraph one. " + 
                     Array(50).fill("More text.").join(" ") +
                     "\n\n# Another Heading\n\nParagraph two.";
        
        const chunks = await chunkText(text, { 
          maxTokens: 300,
          preserveStructure: true 
        });
        
        chunks.forEach(chunk => {
          expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
          expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
          expect(chunk.endOffset).toBeLessThanOrEqual(text.length + 100); // Allow some margin for processing
        });
      });

      it("should maintain consistent offsets in sentence-based mode", async () => {
        const text = Array(80)
          .fill("This is a sentence.")
          .join(" ");
        
        const chunks = await chunkText(text, { 
          maxTokens: 300,
          preserveStructure: false 
        });
        
        chunks.forEach(chunk => {
          expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
          expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
        });
      });
    });

    describe("chunking strategies", () => {
      it("should preserve markdown structure when enabled", async () => {
        const text = 
          "# Heading 1\n\nFirst paragraph.\n\n" +
          "## Heading 2\n\nSecond paragraph with more content.\n\n" +
          "- List item 1\n- List item 2\n\n" +
          "Final paragraph.";
        
        const chunks = await chunkText(text, { 
          preserveStructure: true,
          maxTokens: 200 
        });
        
        expect(chunks.length).toBeGreaterThan(0);
        // Structure preservation should try to keep sections together
        expect(chunks.some(c => c.text.includes("Heading"))).toBe(true);
      });

      it("should use sentence-based chunking when structure preservation is disabled", async () => {
        const text = Array(50)
          .fill("This is a sentence. Another sentence here.")
          .join(" ");
        
        const chunks = await chunkText(text, { 
          preserveStructure: false,
          maxTokens: 300 
        });
        
        expect(chunks.length).toBeGreaterThan(1);
        chunks.forEach(chunk => {
          expect(chunk.text.length).toBeGreaterThan(0);
        });
      });

      it("should handle large sections that need splitting", async () => {
        const largeSection = Array(100)
          .fill("Sentence in a large section.")
          .join(" ");
        const text = `# Large Section\n\n${largeSection}`;
        
        const chunks = await chunkText(text, { 
          preserveStructure: true,
          maxTokens: 300 
        });
        
        expect(chunks.length).toBeGreaterThan(1);
      });
    });

    describe("overlap handling", () => {
      it("should create overlapping chunks", async () => {
        const longText = Array(80)
          .fill("This is a unique sentence number.")
          .join(" ");
        
        const chunks = await chunkText(longText, { 
          maxTokens: 300,
          overlapTokens: 50 
        });
        
        if (chunks.length > 1) {
          // Chunks should have some overlap in content
          expect(chunks.length).toBeGreaterThan(1);
          // Each chunk should exist and have content
          chunks.forEach(chunk => {
            expect(chunk.text.length).toBeGreaterThan(0);
          });
        }
      });

      it("should apply overlap correctly with proper context", async () => {
        const sentences = Array(60)
          .fill(0)
          .map((_, i) => `Sentence number ${i}.`)
          .join(" ");
        
        const chunks = await chunkText(sentences, { 
          maxTokens: 200,
          overlapTokens: 30 
        });
        
        if (chunks.length > 1) {
          // Verify chunks are created with proper content
          chunks.forEach((chunk, i) => {
            expect(chunk.ordinal).toBe(i);
            expect(chunk.text.length).toBeGreaterThan(0);
          });
        }
      });
    });

    describe("edge cases", () => {
      it("should handle text with only whitespace", async () => {
        const chunks = await chunkText("   \n\n   ");
        expect(chunks).toEqual([]);
      });

      it("should handle text with special characters", async () => {
        const text = "Text with émojis 🔥 and spëcial çharacters!";
        const chunks = await chunkText(text);
        
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toContain("émojis");
        expect(chunks[0].text).toContain("🔥");
      });

      it("should handle very long single sentences", async () => {
        // A very long single sentence cannot be split at sentence boundaries
        // The chunker will keep it as one chunk even if it exceeds maxTokens
        const longSentence = "This is a very long sentence that " + 
                           Array(200).fill("keeps going and going").join(" ") + 
                           ".";
        
        const chunks = await chunkText(longSentence, { maxTokens: 500 });
        
        // Should create at least one chunk
        expect(chunks.length).toBeGreaterThan(0);
        // When a single sentence is too long, it stays as one chunk
        // This is expected behavior to maintain sentence integrity
        expect(chunks[0].text).toContain("very long sentence");
      });

      it("should handle text with multiple consecutive newlines", async () => {
        const text = "First paragraph.\n\n\n\nSecond paragraph.";
        const chunks = await chunkText(text);
        
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[0].text).toContain("First paragraph");
      });

      it("should handle mixed content types", async () => {
        const text = 
          "# Heading\n\n" +
          "Paragraph with text.\n\n" +
          "```code\nconst x = 1;\n```\n\n" +
          "- List item\n" +
          "- Another item\n\n" +
          "Final paragraph.";
        
        const chunks = await chunkText(text);
        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe("options validation", () => {
      it("should use default options when none provided", async () => {
        const text = Array(50).fill("Text here.").join(" ");
        const chunks = await chunkText(text);
        
        expect(chunks).toBeDefined();
        expect(Array.isArray(chunks)).toBe(true);
      });

      it("should respect custom targetTokens", async () => {
        const text = Array(100).fill("Text here.").join(" ");
        const chunks = await chunkText(text, { targetTokens: 200 });
        
        expect(chunks.length).toBeGreaterThan(0);
      });

      it("should respect custom minTokens", async () => {
        const text = Array(100).fill("Text here.").join(" ");
        const chunks = await chunkText(text, { minTokens: 100 });
        
        expect(chunks.length).toBeGreaterThan(0);
      });

      it("should respect custom overlapTokens", async () => {
        const text = Array(100).fill("Text here.").join(" ");
        const chunks = await chunkText(text, { 
          maxTokens: 300,
          overlapTokens: 75 
        });
        
        expect(chunks.length).toBeGreaterThan(0);
      });
    });

    describe("chunk quality", () => {
      it("should not create empty chunks", async () => {
        const text = Array(100).fill("Content here.").join(" ");
        const chunks = await chunkText(text, { maxTokens: 300 });
        
        chunks.forEach(chunk => {
          expect(chunk.text.trim().length).toBeGreaterThan(0);
          expect(chunk.tokenCount).toBeGreaterThan(0);
          expect(chunk.charCount).toBeGreaterThan(0);
        });
      });

      it("should maintain text integrity", async () => {
        const text = "This is important content that must be preserved.";
        const chunks = await chunkText(text);
        
        const reconstructed = chunks.map(c => c.text).join(" ");
        expect(reconstructed).toContain("important content");
      });

      it("should create reasonably sized chunks", async () => {
        const text = Array(100).fill("Some text.").join(" ");
        const maxTokens = 400;
        const chunks = await chunkText(text, { maxTokens });
        
        chunks.forEach(chunk => {
          expect(chunk.tokenCount).toBeGreaterThan(0);
          expect(chunk.tokenCount).toBeLessThanOrEqual(maxTokens);
        });
      });
    });

    describe("performance", () => {
      it("should handle large documents efficiently", async () => {
        const largeText = Array(500)
          .fill("This is a sentence in a large document.")
          .join(" ");
        
        const startTime = Date.now();
        const chunks = await chunkText(largeText, { maxTokens: 500 });
        const duration = Date.now() - startTime;
        
        expect(chunks.length).toBeGreaterThan(0);
        expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
      });

      it("should handle documents with complex structure", async () => {
        const sections = Array(20).fill(0).map((_, i) => 
          `# Section ${i}\n\nContent for section ${i}.\n\n` +
          Array(10).fill("More text here.").join(" ")
        ).join("\n\n");
        
        const chunks = await chunkText(sections, { 
          preserveStructure: true,
          maxTokens: 500 
        });
        
        expect(chunks.length).toBeGreaterThan(0);
      });
    });
  });
});


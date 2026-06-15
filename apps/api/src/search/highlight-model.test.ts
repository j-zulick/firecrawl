vi.mock("../config", () => ({
  config: {
    HIGHLIGHT_MODEL_URL: "https://highlight.test",
    HIGHLIGHT_MODEL_TOKEN: "secret-token",
  },
}));

import { generateHighlightsBatch } from "./highlight-model";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("generateHighlightsBatch", () => {
  it("returns [] without calling the service for an empty batch", async () => {
    const fetchMock = mockFetchOnce({ results: [] });
    const out = await generateHighlightsBatch([], { logger });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts every page to /batch_highlight with the bearer token", async () => {
    const fetchMock = mockFetchOnce({
      results: [
        { pruned_markdown: "Highlight A\n" },
        { pruned_markdown: "Highlight B\n" },
      ],
    });

    await generateHighlightsBatch(
      [
        { query: "q1", markdown: "page one" },
        { query: "q2", markdown: "page two" },
      ],
      { logger },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://highlight.test/batch_highlight");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-token");

    const sent = JSON.parse(init.body);
    expect(sent.requests).toHaveLength(2);
    expect(sent.requests[0]).toMatchObject({ query: "q1", markdown: "page one" });
    // Threshold + budget are always sent so the cutoff matches the trained format.
    expect(typeof sent.requests[0].threshold).toBe("number");
    expect(typeof sent.requests[0].max_highlight_chars).toBe("number");
  });

  it("maps pruned_markdown back to each item, trimmed, aligned by index", async () => {
    mockFetchOnce({
      results: [
        { pruned_markdown: "First page highlight\n" },
        { pruned_markdown: "Second page highlight\nmore\n" },
      ],
    });

    const out = await generateHighlightsBatch(
      [
        { query: "q1", markdown: "a" },
        { query: "q2", markdown: "b" },
      ],
      { logger },
    );

    expect(out).toEqual([
      "First page highlight",
      "Second page highlight\nmore",
    ]);
  });

  it("returns null for empty / missing pruned_markdown entries", async () => {
    mockFetchOnce({
      results: [
        { pruned_markdown: "" },
        { pruned_markdown: "   \n" },
        {},
      ],
    });

    const out = await generateHighlightsBatch(
      [
        { query: "q", markdown: "a" },
        { query: "q", markdown: "b" },
        { query: "q", markdown: "c" },
      ],
      { logger },
    );

    expect(out).toEqual([null, null, null]);
  });

  it("falls back to nulls (one per item) when the service errors", async () => {
    mockFetchOnce({ error: "boom" }, false, 500);

    const out = await generateHighlightsBatch(
      [
        { query: "q", markdown: "a" },
        { query: "q", markdown: "b" },
      ],
      { logger },
    );

    expect(out).toEqual([null, null]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

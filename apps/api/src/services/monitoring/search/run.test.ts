import type { Logger } from "winston";
import type { SearchVerdict } from "./judge";
import type { EventResolution } from "./llm";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";

// --- Mock the external boundaries; the orchestration logic in run.ts runs for real. ---
const searchMock = jest.fn();
const scrapeURLMock = jest.fn();
const resolveEventMock = jest.fn();
const summarizeRunMock = jest.fn();

jest.mock("uuid", () => ({ v7: () => "00000000-0000-7000-8000-000000000000" }));
jest.mock("../../../search", () => ({
  search: (...a: unknown[]) => searchMock(...a),
}));
jest.mock("../../../scraper/scrapeURL", () => ({
  scrapeURL: (...a: unknown[]) => scrapeURLMock(...a),
}));
const materialDevMock = jest.fn();
jest.mock("./llm", () => ({
  resolveEvent: (...a: unknown[]) => resolveEventMock(...a),
  summarizeRun: (...a: unknown[]) => summarizeRunMock(...a),
  judgeMaterialDevelopment: (...a: unknown[]) => materialDevMock(...a),
}));

import { runSearchTarget, type KnownPage } from "./run";

const logger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const verdict = (over: Partial<SearchVerdict> = {}): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  freshness: "fresh",
  sourceQuality: "authoritative",
  concept: "openai-ipo",
  rationale: "filing confirmed",
  ...over,
});

const okScrape = (v: SearchVerdict) => ({
  success: true,
  document: { json: v },
});

function setSearchResults(
  results: Array<{ url: string; title: string; description: string }>,
) {
  searchMock.mockResolvedValue(results);
}

// scrapeURL returns a verdict chosen by URL.
function setVerdictsByUrl(map: Record<string, SearchVerdict>) {
  scrapeURLMock.mockImplementation((_id: string, url: string) => {
    const v = map[url];
    if (!v) return Promise.resolve({ success: false });
    return Promise.resolve(okScrape(v));
  });
}

const baseTarget = {
  id: "t1",
  queries: ["openai ipo"],
  searchWindow: "24h",
  alertMode: "first_match" as const,
  maxResults: 10,
};

const baseMonitor = {
  id: "m1",
  teamId: "team1",
  goal: "Alert when OpenAI files for IPO",
  subject: "OpenAI",
};

function run(
  over: {
    target?: Partial<typeof baseTarget> & { recheckAfter?: string };
    knownPages?: Map<string, KnownPage>;
    knownEvents?: EventResolution[] extends never
      ? never
      : { key: string; label: string }[];
    goalVersion?: string;
    alertMode?: "first_match" | "every_new_result" | "material_dev";
  } = {},
) {
  return runSearchTarget({
    monitor: baseMonitor,
    target: {
      ...baseTarget,
      ...over.target,
      alertMode: over.alertMode ?? baseTarget.alertMode,
    },
    goalVersion: over.goalVersion ?? "gv1",
    knownPages: over.knownPages ?? new Map(),
    knownEvents: over.knownEvents ?? [],
    zeroDataRetention: false,
    logger,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveEventMock.mockResolvedValue({
    matchedKey: null,
    isNew: true,
    label: "OpenAI IPO",
    reason: "",
  });
  summarizeRunMock.mockResolvedValue({
    label: "meaningful",
    summary: "OpenAI filed for IPO.",
  });
  materialDevMock.mockResolvedValue({ material: false, reason: "" });
});

describe("runSearchTarget orchestration", () => {
  it("alerts on a new, relevant, fresh result", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });

    const out = await run();

    expect(out.matches).toBe(1);
    expect(out.sources[0].status).toBe("alert");
    expect(out.sources[0].eventKey).toBeTruthy();
    expect(out.pageUpserts[0].status).toBe("alert");
    expect(out.summary).toBe("OpenAI filed for IPO.");
    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
  });

  it("skips scrape/judge for an already-seen unchanged page (same goalVersion)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    // Precompute the fingerprint the same way run.ts does, via the real dedupe module.
    const canonical = canonicalizeUrl("https://sec.gov/openai");
    const fingerprint = stableSerpFingerprint({
      url: "https://sec.gov/openai",
      title: "OpenAI S-1",
      snippet: "filing",
    });
    const knownPages = new Map<string, KnownPage>([
      [canonical, { fingerprint, goalVersion: "gv1", lastStatus: "alert" }],
    ]);

    const out = await run({ knownPages });

    // Reuse carries the prior outcome forward: this page alerted before, so the
    // repeat is "already_seen". A page with no recorded prior alert must not be.
    expect(out.sources[0].status).toBe("already_seen");
    expect(out.pageUpserts[0].status).toBe("already_seen");
    expect(scrapeURLMock).not.toHaveBeenCalled();
    expect(out.matches).toBe(0);
  });

  it("re-evaluates a known page when the goalVersion changed (stale memory)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });
    const canonical = canonicalizeUrl("https://sec.gov/openai");
    const fingerprint = stableSerpFingerprint({
      url: "https://sec.gov/openai",
      title: "OpenAI S-1",
      snippet: "filing",
    });
    // Known under the OLD goal version → must be treated as new under gv2.
    const knownPages = new Map<string, KnownPage>([
      [canonical, { fingerprint, goalVersion: "gv1" }],
    ]);

    const out = await run({ knownPages, goalVersion: "gv2" });

    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("first_match: suppresses a second result resolving to the same event", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
      {
        url: "https://nytimes.com/openai-ipo",
        title: "OpenAI to IPO",
        description: "report",
      },
    ]);
    setVerdictsByUrl({
      "https://sec.gov/openai": verdict(),
      "https://nytimes.com/openai-ipo": verdict({ concept: "openai-ipo" }),
    });
    // First result creates the event; second resolves to the same key.
    resolveEventMock
      .mockResolvedValueOnce({
        matchedKey: null,
        isNew: true,
        label: "OpenAI IPO",
        reason: "",
      })
      .mockResolvedValueOnce({
        matchedKey: "00000000-0000-7000-8000-000000000000",
        isNew: false,
        label: "OpenAI IPO",
        reason: "same",
      });

    const out = await run({ alertMode: "first_match" });

    const statuses = out.sources.map(s => s.status);
    expect(statuses).toContain("alert");
    expect(statuses).toContain("already_seen");
    expect(out.matches).toBe(1);
  });

  it("mints a stable opaque key for new events (not a label slug)", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });
    resolveEventMock.mockResolvedValue({
      matchedKey: null,
      isNew: true,
      label: "OpenAI's IPO Filing!!!",
      reason: "",
    });
    const out = await run();
    // Key is the uuid (mocked constant here), not slugify("OpenAI's IPO Filing!!!").
    expect(out.sources[0].eventKey).toBe(
      "00000000-0000-7000-8000-000000000000",
    );
    expect(out.pageUpserts[0].metadata.eventLabel).toBe(
      "OpenAI's IPO Filing!!!",
    );
  });

  it("reuses a matched event's key even when the new label differs (no drift)", async () => {
    setSearchResults([
      {
        url: "https://reuters.com/openai",
        title: "Reuters: OpenAI IPO",
        description: "report",
      },
    ]);
    setVerdictsByUrl({ "https://reuters.com/openai": verdict() });
    resolveEventMock.mockResolvedValue({
      matchedKey: "evt-stable-123",
      isNew: false,
      label: "A completely reworded label",
      reason: "same event",
    });
    const out = await run({
      knownEvents: [{ key: "evt-stable-123", label: "OpenAI IPO" }],
    });
    expect(out.sources[0].eventKey).toBe("evt-stable-123");
    // Reuses the stored label, ignoring the drifted one from this run.
    expect(out.pageUpserts[0].metadata.eventLabel).toBe("OpenAI IPO");
  });

  it("downgrades a stale-but-alert verdict to watch (no notify)", async () => {
    setSearchResults([
      {
        url: "https://old.com/openai",
        title: "OpenAI old news",
        description: "2019",
      },
    ]);
    setVerdictsByUrl({
      "https://old.com/openai": verdict({ freshness: "stale" }),
    });

    const out = await run();

    expect(out.sources[0].status).toBe("watching");
    expect(out.matches).toBe(0);
    expect(resolveEventMock).not.toHaveBeenCalled();
  });

  it("marks a result skipped when the scrape fails", async () => {
    setSearchResults([
      { url: "https://dead.com/x", title: "x", description: "y" },
    ]);
    scrapeURLMock.mockResolvedValue({ success: false });

    const out = await run();

    expect(out.sources[0].status).toBe("skipped");
    expect(out.skipped).toBe(1);
    expect(out.matches).toBe(0);
  });

  it("dedups the same canonical URL returned by two queries", async () => {
    setSearchResults([
      {
        url: "https://sec.gov/openai",
        title: "OpenAI S-1",
        description: "filing",
      },
      {
        url: "https://www.SEC.gov/openai/",
        title: "OpenAI S-1",
        description: "filing",
      },
    ]);
    setVerdictsByUrl({ "https://sec.gov/openai": verdict() });

    const out = await run();

    expect(out.resultCount).toBe(1);
    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
  });
});

describe("scrape payload validity (real validator, no mocks)", () => {
  // Proves the exact scrape options run.ts sends survive the real v2 validator and yield a
  // json format carrying our verdict schema + prompt — the one integration not covered by
  // matching the scrape/crawl path.
  it("scrapeOptions.parse accepts the verdict json format", () => {
    const { scrapeOptions } = require("../../../controllers/v2/types");
    const { verdictJsonSchema, buildJudgePrompt } = require("./judge");
    const parsed = scrapeOptions.parse({
      formats: [
        {
          type: "json",
          schema: verdictJsonSchema,
          prompt: buildJudgePrompt("goal", "subject", "24h"),
        },
      ],
      timeout: 20000,
    });
    const jsonFormat = (parsed.formats as Array<{ type: string }>).find(
      f => f.type === "json",
    );
    expect(jsonFormat).toBeTruthy();
    expect((jsonFormat as { prompt?: string }).prompt).toContain("goal");
  });
});

describe("material_dev alert mode", () => {
  const serp = [
    {
      url: "https://reuters.com/openai",
      title: "OpenAI prices IPO",
      description: "priced",
    },
  ];
  beforeEach(() => {
    setSearchResults(serp);
    setVerdictsByUrl({ "https://reuters.com/openai": verdict() });
    resolveEventMock.mockResolvedValue({
      matchedKey: "evt-1",
      isNew: false,
      label: "OpenAI IPO",
      reason: "same",
    });
  });

  it("re-alerts on a material development of a known event", async () => {
    materialDevMock.mockResolvedValue({ material: true, reason: "now priced" });
    const out = await run({
      alertMode: "material_dev",
      knownEvents: [{ key: "evt-1", label: "OpenAI IPO" }],
    });
    expect(out.matches).toBe(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("suppresses a non-material retelling of a known event", async () => {
    materialDevMock.mockResolvedValue({
      material: false,
      reason: "just a retelling",
    });
    const out = await run({
      alertMode: "material_dev",
      knownEvents: [{ key: "evt-1", label: "OpenAI IPO" }],
    });
    expect(out.matches).toBe(0);
    expect(out.sources[0].status).toBe("already_seen");
  });
});

describe("re-judge cadence", () => {
  const url = "https://sec.gov/openai";
  const fp = stableSerpFingerprint({
    url,
    title: "OpenAI S-1",
    snippet: "filing",
  });
  const serp = [{ url, title: "OpenAI S-1", description: "filing" }];
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 1000).toISOString();

  it("re-judges a live page whose last check is older than recheckAfter (SERP unchanged)", async () => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
    const knownPages = new Map<string, KnownPage>([
      [
        canonicalizeUrl(url),
        {
          fingerprint: fp,
          goalVersion: "gv1",
          lastCheckedAt: old,
          lastStatus: "watching",
        },
      ],
    ]);
    const out = await run({ target: { recheckAfter: "24h" }, knownPages });
    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
    expect(out.sources[0].status).toBe("alert");
  });

  it("does NOT re-judge when the last check is within recheckAfter", async () => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
    const knownPages = new Map<string, KnownPage>([
      [
        canonicalizeUrl(url),
        {
          fingerprint: fp,
          goalVersion: "gv1",
          lastCheckedAt: recent,
          lastStatus: "watching",
        },
      ],
    ]);
    const out = await run({ target: { recheckAfter: "24h" }, knownPages });
    expect(scrapeURLMock).not.toHaveBeenCalled();
    // A page that only ever watched repeats as watching — "already_seen" is
    // reserved for pages that actually alerted on a prior run.
    expect(out.sources[0].status).toBe("watching");
  });

  it("does NOT re-judge a non-live (ignored) page even when stale", async () => {
    setSearchResults(serp);
    setVerdictsByUrl({ [url]: verdict() });
    const knownPages = new Map<string, KnownPage>([
      [
        canonicalizeUrl(url),
        {
          fingerprint: fp,
          goalVersion: "gv1",
          lastCheckedAt: old,
          lastStatus: "ignored",
        },
      ],
    ]);
    const out = await run({ target: { recheckAfter: "24h" }, knownPages });
    expect(scrapeURLMock).not.toHaveBeenCalled();
    expect(out.sources[0].status).toBe("ignored");
  });
});

describe("date-based freshness", () => {
  it("a real stale publish date vetoes an LLM fresh+alert verdict", async () => {
    setSearchResults([
      {
        url: "https://news.com/openai",
        title: "OpenAI files S-1",
        description: "x",
      },
    ]);
    // LLM says fresh+alert, but the page's real publishedTime is ~2 years old.
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ freshness: "fresh", alertAction: "alert" }),
        metadata: { publishedTime: "2024-01-01T00:00:00Z" },
      },
    });
    const out = await run();
    expect(out.matches).toBe(0);
    expect(out.sources[0].status).toBe("watching");
    expect(out.sources[0].freshness).toBe("stale");
  });

  it("a real fresh date keeps an alert and is recorded as date-sourced", async () => {
    setSearchResults([
      {
        url: "https://news.com/openai",
        title: "OpenAI files S-1",
        description: "x",
      },
    ]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ freshness: "fresh", alertAction: "alert" }),
        metadata: { publishedTime: new Date().toISOString() },
      },
    });
    const out = await run();
    expect(out.matches).toBe(1);
    expect(out.pageUpserts[0].metadata.freshnessSource).toBe("date");
  });
});

describe("domain scoping", () => {
  beforeEach(() => setSearchResults([]));

  it("includeDomains → site: OR filter appended to the query", async () => {
    await runSearchTarget({
      monitor: baseMonitor,
      target: { ...baseTarget, includeDomains: ["sec.gov", "reuters.com"] },
      goalVersion: "gv1",
      knownPages: new Map(),
      knownEvents: [],
      zeroDataRetention: false,
      logger,
    });
    const sentQuery = searchMock.mock.calls[0][0].query as string;
    expect(sentQuery).toContain("openai ipo");
    expect(sentQuery).toContain("(site:sec.gov OR site:reuters.com)");
  });

  it("excludeDomains → -site: filter appended to the query", async () => {
    await runSearchTarget({
      monitor: baseMonitor,
      target: { ...baseTarget, excludeDomains: ["pinterest.com"] },
      goalVersion: "gv1",
      knownPages: new Map(),
      knownEvents: [],
      zeroDataRetention: false,
      logger,
    });
    const sentQuery = searchMock.mock.calls[0][0].query as string;
    expect(sentQuery).toContain("-site:pinterest.com");
  });

  it("includeDomains and excludeDomains combine; exclude wins in the query", async () => {
    await run({
      target: {
        includeDomains: ["reuters.com", "spam.example"],
        excludeDomains: ["spam.example"],
      } as Partial<typeof baseTarget>,
    });
    const sentQuery = searchMock.mock.calls[0][0].query as string;
    expect(sentQuery).toContain("(site:reuters.com OR site:spam.example)");
    expect(sentQuery).toContain("-site:spam.example");
  });

  it("excluded hosts returned by the provider are dropped before judging", async () => {
    setSearchResults([
      { url: "https://www.pinterest.com/pin/1", title: "pin", description: "x" },
      { url: "https://boards.pinterest.com/pin/2", title: "pin", description: "x" },
      { url: "https://news.com/openai", title: "OpenAI files S-1", description: "x" },
    ]);
    setVerdictsByUrl({ "https://news.com/openai": verdict() });
    const out = await run({
      target: { excludeDomains: ["pinterest.com"] } as Partial<typeof baseTarget>,
    });
    expect(out.resultCount).toBe(1);
    expect(out.sources.map(s => s.url)).toEqual(["https://news.com/openai"]);
    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
  });

  it("a host merely containing an excluded domain is not dropped", async () => {
    setSearchResults([
      { url: "https://notpinterest.com/a", title: "t", description: "x" },
    ]);
    setVerdictsByUrl({ "https://notpinterest.com/a": verdict() });
    const out = await run({
      target: { excludeDomains: ["pinterest.com"] } as Partial<typeof baseTarget>,
    });
    expect(out.resultCount).toBe(1);
  });
});

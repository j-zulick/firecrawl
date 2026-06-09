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
jest.mock("./llm", () => ({
  resolveEvent: (...a: unknown[]) => resolveEventMock(...a),
  summarizeRun: (...a: unknown[]) => summarizeRunMock(...a),
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
    target?: Partial<typeof baseTarget>;
    knownPages?: Map<string, KnownPage>;
    knownEvents?: EventResolution[] extends never
      ? never
      : { key: string; label: string }[];
    goalVersion?: string;
    alertMode?: "first_match" | "every_new_result";
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
      [canonical, { fingerprint, goalVersion: "gv1" }],
    ]);

    const out = await run({ knownPages });

    expect(out.sources[0].status).toBe("already_seen");
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
        matchedKey: undefined,
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
});

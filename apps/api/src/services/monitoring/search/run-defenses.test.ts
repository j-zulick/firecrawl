import type { Logger } from "winston";
import type { SearchVerdict } from "./judge";
import { canonicalizeUrl } from "./dedupe";

// vi.mock is hoisted above declarations, so the mocks its factories reference
// are created in vi.hoisted() (also hoisted) to avoid any TDZ surprises.
// The lean pipeline has a single LLM stage: the deep-mode per-page JSON verdict,
// produced by the injected scrapePage.
const { searchMock, scrapeURLMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeURLMock: vi.fn(),
}));

vi.mock("uuid", () => ({ v7: () => "00000000-0000-7000-8000-000000000000" }));
vi.mock("../../../search/v2", () => ({
  // Tests set the mock to resolve a bare result array; the real search() returns
  // a SearchV2Response ({ web: [...] }), so wrap arrays to match that contract.
  search: async (...a: unknown[]) => {
    const r = await searchMock(...a);
    return Array.isArray(r) ? { web: r } : r;
  },
}));
vi.mock("./tuning", () => ({
  hasLlmProvider: () => true,
  googleProviderOptions: () => ({}),
}));

import { runSearchTarget } from "./run";

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const verdict = (over: Partial<SearchVerdict> = {}): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  concept: "Firecrawl product launch",
  rationale: "Firecrawl announced a new product today.",
  ...over,
});

function runParams(
  targetOver: Record<string, unknown> = {},
  monitorOver: Record<string, unknown> = {},
) {
  return {
    monitor: {
      id: "mon_1",
      teamId: "team_1",
      goal: "Alert me when Firecrawl launches a new product",
      subject: "Firecrawl",
      judgeEnabled: true,
      ...monitorOver,
    },
    target: {
      id: "tgt_1",
      queries: ["Firecrawl launch"],
      searchWindow: "24h",
      alertMode: "first_match" as const,
      maxResults: 10,
      ...targetOver,
    },
    monitorCheckId: "check-1",
    // scrapeURLMock keeps the legacy { success, document } shape; adapt it to the
    // ScrapeSearchResult the injected scrapePage now returns.
    scrapePage: async (...a: unknown[]) => {
      const r = (await scrapeURLMock(...a)) as {
        success?: boolean;
        document?: {
          json: unknown;
          markdown?: string;
          metadata?: { publishedTime?: string; modifiedTime?: string };
        };
      } | null;
      return r && r.success && r.document
        ? {
            json: r.document.json ?? null,
            markdown: r.document.markdown ?? "",
            metadata: r.document.metadata ?? {},
          }
        : null;
    },
    goalVersion: "v1",
    knownPages: new Map(),
    knownEvents: [],
    zeroDataRetention: false,
    logger,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const serpRow = (n: number) => ({
  url: `https://news${n}.example.com/story`,
  title: `Firecrawl launches product ${n}`,
  description: `Firecrawl announced product ${n} today.`,
});

describe("deep mode (scrape every selected candidate)", () => {
  it("scrapes every result up to maxResults (no router gating)", async () => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2), serpRow(3)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "watch" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(scrapeURLMock).toHaveBeenCalledTimes(3);
    expect(result.matches).toBe(0);
  });
});

describe("alert boundary (the per-page JSON verdict is the gate)", () => {
  beforeEach(() => {
    searchMock.mockResolvedValue([serpRow(1)]);
  });

  it("a clean alert verdict on a fresh result alerts", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(1);
    expect(result.sources[0].status).toBe("alert");
  });

  it("a watch verdict does not alert", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "watch" }),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("watching");
  });

  it("an ignore verdict does not alert", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "Off-topic prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("ignored");
  });
});

describe("event state stamps + judgment on alert pages", () => {
  it("stamps satisfiedAt/alertCount/lastAlertAt and a judgment on the alerting page", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.eventAlertCount).toBe(1);
    expect(typeof alertUpsert.metadata.eventSatisfiedAt).toBe("string");
    expect(typeof alertUpsert.metadata.eventLastAlertAt).toBe("string");
    expect(alertUpsert.judgment).toMatchObject({
      meaningful: true,
      confidence: "high",
      reason: "Firecrawl announced a new product today.",
    });
  });

  it("a later alert on a known event (every_new_result) increments alertCount and keeps satisfiedAt", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget({
      ...runParams({ alertMode: "every_new_result" }),
      knownEvents: [
        {
          key: canonicalizeUrl(serpRow(1).url),
          label: "Firecrawl product launch",
          satisfiedAt: "2026-06-01T00:00:00Z",
          alertCount: 2,
        },
      ],
    });
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.eventAlertCount).toBe(3);
    expect(alertUpsert.metadata.eventSatisfiedAt).toBe("2026-06-01T00:00:00Z");
  });
});

describe("judgeEnabled gates the LLM judge", () => {
  it("judge OFF behaves like raw: no LLM stages, no LLM credits, no concept/rationale", async () => {
    // Monitor still has a goal and depth:"deep" — but judgeEnabled=false must
    // collapse to raw and skip every LLM stage.
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: false }),
    );

    // No judge stage ran: raw mode does not scrape.
    expect(scrapeURLMock).not.toHaveBeenCalled();

    // No judge credits billed (raw → nothing judged); search still ran and was billed.
    expect(result.judgeCredits).toBe(0);
    expect(result.resultsJudged).toBe(0);
    expect(result.resultCount).toBe(2);

    // Raw alerts: deterministic searchStatus from dedup, but no LLM
    // concept/rationale on any upsert.
    for (const upsert of result.pageUpserts) {
      expect(upsert.scraped).toBe(false);
      expect(upsert.metadata.concept).toBeUndefined();
      expect(upsert.metadata.rationale).toBeUndefined();
      expect(upsert.metadata.searchStatus).toBeDefined();
    }
  });

  it("judge OFF with no goal still runs search and returns raw results (no throw)", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: false, goal: null }),
    );

    expect(result.resultCount).toBe(1);
    expect(result.judgeCredits).toBe(0);
    expect(result.resultsJudged).toBe(0);
    expect(scrapeURLMock).not.toHaveBeenCalled();
  });

  it("judge ON with depth:deep scrapes and judges per page", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(
      runParams({ depth: "deep" }, { judgeEnabled: true }),
    );

    expect(scrapeURLMock).toHaveBeenCalled();
    expect(result.matches).toBe(1);
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.concept).toBeDefined();
  });
});

describe("deep-path scrape failures mark the check degraded (no silent empty)", () => {
  beforeEach(() => {
    // Two candidates scraped; scrape outcome varies per test.
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
  });

  it("degraded=true when EVERY deep-path scrape fails (judging expected, nothing judged)", async () => {
    scrapeURLMock.mockResolvedValue({ success: false });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // The false-negative we must surface: 0 judged / 0 alerts, but degraded.
    expect(result.resultsJudged).toBe(0);
    expect(result.matches).toBe(0);
    expect(result.judgeDegraded).toBe(true);
    expect(result.degradedReason).toMatch(/judged|incomplete/i);
    // A non-empty summary so the check never reads as a clean "nothing new".
    expect(result.summary).not.toBe("");
    // Each unscrapeable result is persisted as a "skipped" page so it surfaces
    // as an error check page (skipped -> error) instead of silently vanishing.
    const skippedUpserts = result.pageUpserts.filter(
      u => u.status === "skipped",
    );
    expect(skippedUpserts).toHaveLength(2);
    expect(skippedUpserts[0].metadata.searchStatus).toBe("skipped");
    expect(skippedUpserts[0].metadata.judgedThisRun).toBe(false);
  });

  it("degraded=true when scrapes throw", async () => {
    scrapeURLMock.mockRejectedValue(new Error("scrape timed out"));

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultsJudged).toBe(0);
    expect(result.judgeDegraded).toBe(true);
    expect(result.degradedReason).toMatch(/judged|incomplete/i);
  });

  it("NOT degraded when at least one scrape succeeds and is judged", async () => {
    scrapeURLMock.mockImplementation(({ url }: { url: string }) =>
      url === serpRow(1).url
        ? Promise.resolve({
            success: true,
            document: {
              json: verdict({ alertAction: "ignore" }),
              markdown: "prose",
              metadata: {},
            },
          })
        : Promise.resolve({ success: false }),
    );

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // One result was actually judged (ignored) — that's a real evaluation, not a
    // failure, so the check is NOT degraded even though a sibling scrape failed.
    expect(result.resultsJudged).toBe(1);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("NOT degraded when the judge legitimately ignores every (scraped) result", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    // Everything scraped fine and was evaluated; judge ignored it all. Normal.
    expect(result.resultsJudged).toBe(2);
    expect(result.matches).toBe(0);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it("NOT degraded when search legitimately returns zero results", async () => {
    searchMock.mockResolvedValue([]);

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultCount).toBe(0);
    expect(result.judgeDegraded).toBe(false);
    expect(result.degradedReason).toBeNull();
    expect(scrapeURLMock).not.toHaveBeenCalled();
  });

  it("flags partialScrapeLoss (soft signal, NOT degraded) when most scrapes fail but some judge", async () => {
    searchMock.mockResolvedValue([
      serpRow(1),
      serpRow(2),
      serpRow(3),
      serpRow(4),
    ]);
    // Only result 1 scrapes + judges; results 2-4 all fail to scrape.
    scrapeURLMock.mockImplementation(({ url }: { url: string }) =>
      url === serpRow(1).url
        ? Promise.resolve({
            success: true,
            document: {
              json: verdict({ alertAction: "ignore" }),
              markdown: "prose",
              metadata: {},
            },
          })
        : Promise.resolve({ success: false }),
    );

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.resultsJudged).toBe(1);
    expect(result.scrapeFailures).toBe(3);
    // 3/(1+3) = 0.75 >= 0.5 -> soft partial-loss signal, but the run still
    // produced a verdict so it is NOT a hard degrade.
    expect(result.partialScrapeLoss).toBe(true);
    expect(result.judgeDegraded).toBe(false);
  });

  it("does NOT flag partialScrapeLoss when every scrape succeeds", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "ignore" }),
        markdown: "prose",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams({ depth: "deep" }));

    expect(result.scrapeFailures).toBe(0);
    expect(result.partialScrapeLoss).toBe(false);
  });
});

describe("run time budget (a single check can't wedge the consumer)", () => {
  it("stops waiting on a hung pre-scrape and returns skipped+degraded", async () => {
    vi.useFakeTimers();
    try {
      searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
      // Scrapes never resolve — the pre-scrape can't finish on its own.
      scrapeURLMock.mockReturnValue(new Promise(() => {}));

      const pending = runSearchTarget(runParams({ depth: "deep" }));
      // Advance past the 4-minute run budget so the deadline fires.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 1000);
      const result = await pending;

      expect(result.matches).toBe(0);
      expect(result.resultsJudged).toBe(0);
      expect(result.judgeDegraded).toBe(true);
      const skipped = result.pageUpserts.filter(u => u.status === "skipped");
      expect(skipped).toHaveLength(2);
      expect(skipped[0].metadata.searchStatus).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });
});

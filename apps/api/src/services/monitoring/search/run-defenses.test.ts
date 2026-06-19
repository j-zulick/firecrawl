import type { Logger } from "winston";
import type { SearchVerdict } from "./judge";

const searchMock = jest.fn();
const scrapeURLMock = jest.fn();
const resolveEventMock = jest.fn();
const summarizeRunMock = jest.fn();
const materialDevMock = jest.fn();
const reviewAlertMock = jest.fn();
const routeMock = jest.fn();
const snippetsMock = jest.fn();
const criteriaLlmMock = jest.fn();

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
  judgeMaterialDevelopment: (...a: unknown[]) => materialDevMock(...a),
  reviewAlert: (...a: unknown[]) => reviewAlertMock(...a),
  routeSearchResults: (...a: unknown[]) => routeMock(...a),
  judgeSnippets: (...a: unknown[]) => snippetsMock(...a),
}));
jest.mock("./tuning", () => ({
  hasGeminiKey: () => true,
  googleProviderOptions: () => ({}),
}));
jest.mock("./criteria", () => ({
  ...jest.requireActual("./criteria"),
  compileGoalCriteriaWithLlm: (...a: unknown[]) => criteriaLlmMock(...a),
}));

import { runSearchTarget } from "./run";

const logger = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const verdict = (over: Partial<SearchVerdict> = {}): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  concept: "Firecrawl product launch",
  rationale: "Firecrawl announced a new product today.",
  ...over,
});

const llmCriteria = {
  goalVersion: "v1",
  generatedBy: "llm" as const,
  subjectAliases: ["Firecrawl"],
  mustConcern: ["launch", "launches", "launched", "product"],
  excludedSubjects: ["Parallel"],
  ownedHosts: ["firecrawl.dev"],
  thirdPartyOnly: false,
};

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
    goalVersion: "v1",
    knownPages: new Map(),
    knownEvents: [],
    zeroDataRetention: false,
    logger,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  criteriaLlmMock.mockResolvedValue(llmCriteria);
  resolveEventMock.mockResolvedValue({
    matchedKey: null,
    isNew: true,
    label: "Firecrawl product launch",
    reason: "",
  });
  summarizeRunMock.mockResolvedValue({ label: "meaningful", summary: "ok" });
  reviewAlertMock.mockResolvedValue({
    refuted: false,
    failureMode: "none",
    reason: "",
  });
});

const serpRow = (n: number) => ({
  url: `https://news${n}.example.com/story`,
  title: `Firecrawl launches product ${n}`,
  description: `Firecrawl announced product ${n} today.`,
});

describe("router gating (deep)", () => {
  it("scrapes only candidates the router selects", async () => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2), serpRow(3)]);
    routeMock.mockResolvedValue([
      { id: "result_2", decision: "scrape", priority: 1, reason: "promising" },
    ]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced product 2 today in prose.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(scrapeURLMock).toHaveBeenCalledTimes(1);
    expect(scrapeURLMock.mock.calls[0][1]).toBe(serpRow(2).url);
    expect(result.matches).toBe(1);
  });

  it("fails open to top-K when the router throws", async () => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
    routeMock.mockRejectedValue(new Error("router down"));
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ alertAction: "watch" }),
        markdown: "",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(scrapeURLMock).toHaveBeenCalledTimes(2);
    expect(result.matches).toBe(0);
  });
});

describe("standard depth (snippet judging, no scrapes)", () => {
  it("judges from snippets without any page fetch", async () => {
    searchMock.mockResolvedValue([serpRow(1), serpRow(2)]);
    snippetsMock.mockResolvedValue([
      { id: "result_1", ...verdict() },
      { id: "result_2", ...verdict({ alertAction: "watch" }) },
    ]);

    const result = await runSearchTarget(runParams({ depth: "standard" }));
    expect(scrapeURLMock).not.toHaveBeenCalled();
    expect(routeMock).not.toHaveBeenCalled();
    expect(result.pagesChecked).toBe(2);
    expect(result.matches).toBe(1);
    expect(result.sources.map(s => s.status).sort()).toEqual([
      "alert",
      "watching",
    ]);
    // snippet-only judgments never bill a scrape
    expect(result.pageUpserts.every(u => u.scraped === false)).toBe(true);
  });

  it("skips results the snippet judge failed to cover", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    snippetsMock.mockRejectedValue(new Error("batch failed"));

    const result = await runSearchTarget(runParams({ depth: "standard" }));
    expect(result.skipped).toBe(1);
    expect(result.matches).toBe(0);
  });
});

describe("alert boundary", () => {
  beforeEach(() => {
    searchMock.mockResolvedValue([serpRow(1)]);
    routeMock.mockResolvedValue([
      { id: "result_1", decision: "scrape", priority: 1, reason: "" },
    ]);
  });

  it("verifier downgrades a competitor-dominated story to watching", async () => {
    searchMock.mockResolvedValue([
      {
        url: "https://news.example.com/parallel",
        title: "Parallel launches Monitor API",
        description: "Parallel launched a product; Firecrawl is a competitor.",
      },
    ]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({ concept: "Parallel Monitor API launch" }),
        markdown:
          "Parallel launched its Monitor API today. Firecrawl is named as a competitor.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("watching");
    expect(reviewAlertMock).not.toHaveBeenCalled();
  });

  it("skeptic refutation downgrades to watching", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });
    reviewAlertMock.mockResolvedValue({
      refuted: true,
      failureMode: "adjacent_event",
      reason: "funding, not a launch",
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("watching");
  });

  it("skeptic outage fails open (alert proceeds)", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });
    reviewAlertMock.mockRejectedValue(new Error("skeptic down"));

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(1);
  });

  it("resolver outage fails open to a new event (alert proceeds)", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });
    resolveEventMock.mockRejectedValue(new Error("resolver down"));

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(1);
    expect(result.sources[0].status).toBe("alert");
  });

  it("criteria LLM failure keeps the deterministic compile (run completes)", async () => {
    criteriaLlmMock.mockRejectedValue(new Error("criteria down"));
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
  });
});

describe("event state stamps + judgment on alert pages", () => {
  it("stamps satisfiedAt/alertCount/lastAlertAt and a judgment on the alerting page", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    routeMock.mockResolvedValue([
      { id: "result_1", decision: "scrape", priority: 1, reason: "" },
    ]);
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

  it("a later alert on a known satisfied event increments alertCount and keeps satisfiedAt", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    routeMock.mockResolvedValue([
      { id: "result_1", decision: "scrape", priority: 1, reason: "" },
    ]);
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict(),
        markdown: "Firecrawl announced a new product today in prose.",
        metadata: {},
      },
    });
    resolveEventMock.mockResolvedValue({
      matchedKey: "evt-known",
      isNew: false,
      label: "Firecrawl product launch",
      reason: "",
    });
    materialDevMock.mockResolvedValue({ material: true, reason: "new stage" });

    const result = await runSearchTarget({
      ...runParams({ alertMode: "material_dev" }),
      knownEvents: [
        {
          key: "evt-known",
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

    // No LLM stage ran.
    expect(routeMock).not.toHaveBeenCalled();
    expect(snippetsMock).not.toHaveBeenCalled();
    expect(scrapeURLMock).not.toHaveBeenCalled();
    expect(reviewAlertMock).not.toHaveBeenCalled();
    expect(resolveEventMock).not.toHaveBeenCalled();
    expect(summarizeRunMock).not.toHaveBeenCalled();
    expect(criteriaLlmMock).not.toHaveBeenCalled();

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

  it("judge ON with depth:deep still runs the full judge", async () => {
    searchMock.mockResolvedValue([serpRow(1)]);
    routeMock.mockResolvedValue([
      { id: "result_1", decision: "scrape", priority: 1, reason: "" },
    ]);
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

    expect(routeMock).toHaveBeenCalled();
    expect(scrapeURLMock).toHaveBeenCalled();
    expect(result.matches).toBe(1);
    const alertUpsert = result.pageUpserts.find(u => u.status === "alert")!;
    expect(alertUpsert.metadata.concept).toBeDefined();
  });
});

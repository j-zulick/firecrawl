import type { Logger } from "winston";
import type { SearchVerdict } from "./judge";

// --- Mock the external boundaries; the orchestration logic in run.ts runs for real. ---
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
// LLM stages on: these tests exercise the router / skeptic / verifier wiring.
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
  freshness: "fresh",
  sourceQuality: "authoritative",
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

function runParams(targetOver: Record<string, unknown> = {}) {
  return {
    monitor: {
      id: "mon_1",
      teamId: "team_1",
      goal: "Alert me when Firecrawl launches a new product",
      subject: "Firecrawl",
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
    expect(reviewAlertMock).not.toHaveBeenCalled(); // refuted before the skeptic spends tokens
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

  it("self-contradicting verdict is corrected before alerting", async () => {
    scrapeURLMock.mockResolvedValue({
      success: true,
      document: {
        json: verdict({
          rationale: "The page does not mention Firecrawl anywhere.",
        }),
        markdown: "Unrelated prose about something else entirely.",
        metadata: {},
      },
    });

    const result = await runSearchTarget(runParams());
    expect(result.matches).toBe(0);
    expect(result.sources[0].status).toBe("ignored");
  });
});

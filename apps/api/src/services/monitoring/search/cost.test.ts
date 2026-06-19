import { CostTracking } from "../../../lib/cost-tracking";
import { recordLlmCall } from "./cost";

// Mirror of JUDGE_CREDITS_PER_RESULT in ./run.ts. We intentionally do NOT import
// from ./run here: run.ts pulls in the search/scrape stack (ESM `uuid`, native
// modules) which the jest transform can't load in this suite. The value is a
// stable billing constant; this test pins it and the flat-billing arithmetic.
const JUDGE_CREDITS_PER_RESULT = 5;

// Monitor judge billing is now a FLAT, deterministic figure (5 credits per
// result the judge evaluates). recordLlmCall still records token usage into a
// shared CostTracking, but that is ONLY for observability — it no longer feeds
// the credits a team is charged.
describe("search-monitor LLM cost recording (observability only)", () => {
  it("records a call's token cost into the shared CostTracking", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "gemini-flash-lite-latest",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      stage: "routeSearchResults",
    });
    // gemini-flash-lite-latest: $0.10 in + $0.40 out per 1M tokens.
    expect(ct.toJSON().totalCost).toBeCloseTo(0.5, 6);
  });

  it("normalizes promptTokens/completionTokens (older SDK usage shape)", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "gemini-flash-lite-latest",
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      stage: "summarizeRun",
    });
    expect(ct.toJSON().totalCost).toBeCloseTo(0.1, 6);
  });

  it("returns 0 cost for an unknown/unpriced model rather than throwing", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "some-model-with-no-price",
      usage: { inputTokens: 1000, outputTokens: 1000 },
      stage: "test",
    });
    expect(ct.toJSON().totalCost).toBe(0);
  });
});

describe("search-monitor FLAT judge billing rate", () => {
  it("is a deterministic 5 credits per judged result", () => {
    expect(JUDGE_CREDITS_PER_RESULT).toBe(5);
  });

  it("computes judge credits as 5 * resultsJudged", () => {
    const judgeCreditsFor = (resultsJudged: number) =>
      resultsJudged * JUDGE_CREDITS_PER_RESULT;
    expect(judgeCreditsFor(0)).toBe(0); // raw / judge-off
    expect(judgeCreditsFor(3)).toBe(15); // deep, 3 results judged
    expect(judgeCreditsFor(10)).toBe(50);
  });
});

// The CANONICAL "judged result" definition, pinned so billing and the eval stay
// in lockstep. A judged result is one scraped+judged (deep) or snippet-judged
// (standard) THIS run — run.ts increments resultsJudged exactly once per such
// result and stamps metadata.judgedThisRun=true on its persisted page. The
// billed count therefore equals the number of pages with judgedThisRun=true.
// Reused (unchanged), raw, and skipped pages are NOT judged this run and carry
// judgedThisRun=false / absent — even if they retain a stale `concept`.
describe("canonical judged-result count (billing == persisted signal)", () => {
  type Page = { searchStatus: string; judgedThisRun?: boolean; concept?: string };
  const billedJudgedCount = (pages: Page[]) =>
    pages.filter(p => p.judgedThisRun === true).length;

  it("counts judgedThisRun=true, NOT every page nor every page with a concept", () => {
    // The judged#1 shape: 6 results, only 1 re-judged this run; the other two
    // "concept" pages are REUSED from a prior run (judgedThisRun=false) and a
    // skipped page got no verdict. Counting pages-with-concept gives 3 (the old
    // eval undercount mismatch); the canonical count is 1.
    const pages: Page[] = [
      { searchStatus: "alert", judgedThisRun: true, concept: "fresh-verdict" },
      { searchStatus: "already_seen", judgedThisRun: false, concept: "stale-1" },
      { searchStatus: "watching", judgedThisRun: false, concept: "stale-2" },
      { searchStatus: "skipped" }, // no verdict, no judgedThisRun
    ];
    expect(pages.filter(p => p.concept).length).toBe(3); // the misleading count
    expect(billedJudgedCount(pages)).toBe(1); // the canonical, billed count
    expect(billedJudgedCount(pages) * JUDGE_CREDITS_PER_RESULT).toBe(5);
  });

  it("counts judged results across every billed outcome (alert/watch/ignore/already_seen)", () => {
    const pages: Page[] = [
      { searchStatus: "alert", judgedThisRun: true },
      { searchStatus: "watching", judgedThisRun: true },
      { searchStatus: "ignored", judgedThisRun: true },
      { searchStatus: "already_seen", judgedThisRun: true },
      { searchStatus: "skipped" }, // verdict failed -> not billed
    ];
    expect(billedJudgedCount(pages)).toBe(4); // -> 5*4 = 20 judge credits
  });
});

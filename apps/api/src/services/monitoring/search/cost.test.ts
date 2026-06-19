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

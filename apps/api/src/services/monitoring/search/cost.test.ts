import { CostTracking } from "../../../lib/cost-tracking";
import { recordLlmCall, llmCostToCredits } from "./cost";

describe("search-monitor LLM cost billing", () => {
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

  it("converts accumulated dollar cost to credits via the platform's at-cost rule", () => {
    const ct = new CostTracking();
    recordLlmCall({
      costTracking: ct,
      model: "gemini-flash-lite-latest",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      stage: "routeSearchResults",
    });
    // tokensBilled = ceil(0.5 * 20000) = 10000; credits = ceil(10000 / 15) = 667.
    expect(llmCostToCredits(ct)).toBe(667);
  });

  it("returns 0 credits when no LLM calls were made", () => {
    expect(llmCostToCredits(new CostTracking())).toBe(0);
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
    expect(llmCostToCredits(ct)).toBe(0);
  });
});

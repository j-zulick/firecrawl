import { CostTracking } from "../../../lib/cost-tracking";
import { calculateCost } from "../../../scraper/scrapeURL/transformers/llmExtract";
import { calculateThinkingCost } from "../../../lib/extract/usage/llm-cost";

// AI SDK `generateObject` returns token usage under `usage.inputTokens` /
// `usage.outputTokens`. Older SDK builds expose `promptTokens` /
// `completionTokens`; normalize both so cost recording never silently drops to 0.
type RawUsage =
  | {
      inputTokens?: number;
      outputTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
    }
  | undefined
  | null;

function inputTokensOf(usage: RawUsage): number {
  return usage?.inputTokens ?? usage?.promptTokens ?? 0;
}

function outputTokensOf(usage: RawUsage): number {
  return usage?.outputTokens ?? usage?.completionTokens ?? 0;
}

/**
 * Record a single monitor LLM call against a shared CostTracking, mirroring how
 * the scrape/extract path bills LLM work "at cost" (llmExtract.ts → calculateCost
 * → CostTracking.addCall). The dollar cost is later converted to credits via
 * {@link llmCostToCredits}, the same conversion extract uses.
 */
export function recordLlmCall(params: {
  costTracking: CostTracking;
  model: string;
  usage: RawUsage;
  stage: string;
}): void {
  const input = inputTokensOf(params.usage);
  const output = outputTokensOf(params.usage);
  params.costTracking.addCall({
    type: "other",
    metadata: { source: "search-monitor", stage: params.stage },
    model: params.model,
    cost: calculateCost(params.model, input, output),
    tokens: { input, output },
  });
}

/**
 * Convert the accumulated LLM dollar cost into credits. Uses the platform's
 * canonical at-cost conversion: calculateThinkingCost(ct) = ceil(totalCost *
 * 20000) tokens, then ceil(tokens / 15) credits — identical to how the extract
 * endpoint bills its fire-1 / thinking LLM work (extraction-service.ts).
 */
export function llmCostToCredits(costTracking: CostTracking): number {
  const tokensBilled = calculateThinkingCost(costTracking);
  if (tokensBilled <= 0) return 0;
  return Math.ceil(tokensBilled / 15);
}

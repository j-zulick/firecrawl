import { CostTracking } from "../../../lib/cost-tracking";
import { calculateCost } from "../../../scraper/scrapeURL/transformers/llmExtract";

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
 * the scrape/extract path records LLM work (llmExtract.ts → calculateCost →
 * CostTracking.addCall).
 *
 * NOTE: monitor JUDGE BILLING NO LONGER reads from this CostTracking. Judge
 * credits are a FLAT 5 per judged result (see JUDGE_CREDITS_PER_RESULT in
 * run.ts), computed deterministically at check time. This recording is retained
 * purely for observability/debugging of token usage — it does not affect the
 * credits a team is charged.
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

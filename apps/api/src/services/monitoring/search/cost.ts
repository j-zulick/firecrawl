import { CostTracking } from "../../../lib/cost-tracking";
import { calculateCost } from "../../../scraper/scrapeURL/transformers/llmExtract";

// Newer AI SDK exposes usage as inputTokens/outputTokens, older builds as
// promptTokens/completionTokens; accept both so cost never silently drops to 0.
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
 * Record a single monitor LLM call against a shared CostTracking, mirroring the
 * scrape/extract path (llmExtract.ts → calculateCost → CostTracking.addCall).
 * For observability only — judge billing is a flat per-result figure (see
 * JUDGE_CREDITS_PER_RESULT in run.ts) and does not read from this.
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

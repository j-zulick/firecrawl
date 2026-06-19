import { CostTracking } from "../../../lib/cost-tracking";
import { calculateCost } from "../../../scraper/scrapeURL/transformers/llmExtract";

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

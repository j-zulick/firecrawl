import { generateObject } from "ai";
import { z } from "zod";
import {
  googleModel,
  googleProviderOptions,
  type LlmUsageLabels,
} from "./tuning";
import { recordLlmCall } from "./cost";
import type { CostTracking } from "../../../lib/cost-tracking";

const ROUTER_MODEL = "gemini-3-flash-preview";

export type KnownEvent = {
  key: string;
  label: string;
  satisfiedAt?: string;
  alertCount?: number;
};

const snippetVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      relevant: z.boolean(),
      alertAction: z.enum(["alert", "watch", "ignore"]),
      concept: z.string(),
      rationale: z.string(),
    }),
  ),
});

export type SnippetVerdict = z.infer<
  typeof snippetVerdictSchema
>["verdicts"][number];

export async function judgeSnippets(params: {
  goal: string;
  subject: string;
  searchWindow: string;
  candidates: Array<{
    id: string;
    query: string;
    title: string;
    url: string;
    snippet: string;
  }>;
  costTracking?: CostTracking;
  labels?: LlmUsageLabels;
}): Promise<SnippetVerdict[]> {
  if (params.candidates.length === 0) return [];
  const { object, usage } = await generateObject({
    model: googleModel(ROUTER_MODEL),
    schema: snippetVerdictSchema,
    system:
      "You judge search results for a monitoring product using ONLY each result's SERP title, URL, and snippet — you cannot see the page. Be conservative: a snippet is thin evidence, so alertAction alert requires the snippet itself to concretely state a completed, recent event satisfying the goal, from a source credible for that claim (the subject itself or established reporting). The goal names a SPECIFIC topic/scope: the result's core subject must actually match that specific subject matter, not merely be related, adjacent, or in the same broad field — a credible source or the right organization on an adjacent topic is NOT enough. Treat any 'Ignore/except/not/exclude' clause in the goal as a hard exclusion. Query wording echoed in a snippet is not evidence. Rumors, content farms, competitors, look-alikes, listings, and old or unconfirmed results are watch/ignore. concept: a short reusable label naming the real-world event; describe what the result is actually about, do not reword it to match the goal. rationale: concrete snippet facts only, never references to the monitor or goal. Return one verdict per candidate id. Structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      searchWindow: params.searchWindow,
      candidates: params.candidates.slice(0, 50),
    }),
    temperature: 0,
    ...googleProviderOptions("judgeSnippets", params.labels),
  });
  if (params.costTracking) {
    recordLlmCall({
      costTracking: params.costTracking,
      model: ROUTER_MODEL,
      usage,
      stage: "judgeSnippets",
    });
  }
  const validIds = new Set(params.candidates.map(c => c.id));
  return object.verdicts.filter(v => validIds.has(v.id));
}

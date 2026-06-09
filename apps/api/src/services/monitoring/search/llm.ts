import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

// Gemini LLM calls for the search monitor (mirrors services/monitoring/judgeChange.ts).
// Cost: Gemini 3 Flash reasoning tokens dominate output — use a low thinking budget and
// batch the resolver when scaling.

const EVENT_MODEL =
  process.env.SEARCH_MONITOR_EVENT_MODEL ?? "gemini-3-flash-preview";
const SUMMARY_MODEL =
  process.env.SEARCH_MONITOR_SUMMARY_MODEL ?? "gemini-3-flash-preview";

export type KnownEvent = { key: string; label: string };

export type EventResolution = {
  matchedKey: string | null;
  isNew: boolean;
  label: string;
  reason: string;
};

const eventResolverSchema = z.object({
  matchedKey: z.string().nullable(),
  isNew: z.boolean(),
  label: z.string(),
  reason: z.string(),
});

export async function resolveEvent(params: {
  goal: string;
  subject: string;
  result: { title: string; url: string; evidence: string };
  candidates: KnownEvent[];
}): Promise<EventResolution> {
  const { object } = await generateObject({
    model: google(EVENT_MODEL),
    schema: eventResolverSchema,
    system:
      "You deduplicate real-world events for a monitoring product. Given a new meaningful result and a list of already-known events, decide if the result describes the SAME underlying event as one of them (a different outlet, headline, or wording still counts as the same event) or a genuinely NEW event. Match to an existing event whenever it is the same development. Return structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      knownEvents: params.candidates
        .slice(0, 20)
        .map(c => ({ key: c.key, label: c.label })),
      newResult: {
        title: params.result.title,
        url: params.result.url,
        evidence: (params.result.evidence || "").slice(0, 500),
      },
      instructions: [
        "If newResult is the same underlying event as a knownEvent, set matchedKey to that event's key and isNew false.",
        "Only set isNew true when this is a distinct development not represented by any knownEvent.",
        "label: when matched, reuse the matched event's label; when new, write a short reusable label naming the company/product/event.",
        "A new article from a different publisher about the same filing/launch/recall is NOT a new event.",
      ],
    }),
    temperature: 0,
  });

  return {
    matchedKey: object.matchedKey ?? null,
    isNew: object.matchedKey ? false : object.isNew !== false,
    label: object.label ?? "",
    reason: object.reason ?? "",
  };
}

const runSummarySchema = z.object({
  label: z.enum(["meaningful", "already_satisfied", "not_meaningful"]),
  summary: z.string(),
});

export async function summarizeRun(params: {
  goal: string;
  subject: string;
  evidence: Array<{ title: string; url: string; rationale: string }>;
}): Promise<{ label: string; summary: string }> {
  const { object } = await generateObject({
    model: google(SUMMARY_MODEL),
    schema: runSummarySchema,
    system:
      "You write concise user-facing search-monitor check summaries. Use only the provided monitor goal and meaningful source evidence. Do not introduce facts not present in the evidence. Return structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      evidence: params.evidence.slice(0, 8),
      instructions: [
        "Summarize why the meaningful sources satisfy the goal as a group, in one short sentence.",
        "If sources are meaningful but already reported, say they are related evidence, not a new notification.",
      ],
    }),
    temperature: 0,
  });

  return { label: object.label, summary: object.summary };
}

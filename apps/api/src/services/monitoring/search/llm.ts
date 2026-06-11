import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { googleProviderOptions } from "./tuning";
import type { GoalCriteria } from "./criteria";

// Gemini LLM calls for the search monitor (mirrors services/monitoring/judgeChange.ts).
// Every call runs with thinking suppressed (see tuning.ts) — reasoning tokens measured
// at ~85% of output spend on these structured tasks with no accuracy gain.

const EVENT_MODEL =
  process.env.SEARCH_MONITOR_EVENT_MODEL ?? "gemini-3-flash-preview";
const SUMMARY_MODEL =
  process.env.SEARCH_MONITOR_SUMMARY_MODEL ?? "gemini-3-flash-preview";
const SKEPTIC_MODEL =
  process.env.SEARCH_MONITOR_SKEPTIC_MODEL ?? "gemini-3-flash-preview";
const ROUTER_MODEL =
  process.env.SEARCH_MONITOR_ROUTER_MODEL ?? "gemini-3-flash-preview";

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
    ...googleProviderOptions(EVENT_MODEL),
  });

  return {
    matchedKey: object.matchedKey ?? null,
    isNew: object.matchedKey ? false : object.isNew !== false,
    label: object.label ?? "",
    reason: object.reason ?? "",
  };
}

const materialDevSchema = z.object({
  material: z.boolean(),
  reason: z.string(),
});

// For alertMode "material_dev": does this new result add materially-new information to an
// already-alerted event (e.g. IPO filed → priced → traded), vs just another retelling?
export async function judgeMaterialDevelopment(params: {
  goal: string;
  subject: string;
  eventLabel: string;
  result: { title: string; evidence: string };
}): Promise<{ material: boolean; reason: string }> {
  const { object } = await generateObject({
    model: google(EVENT_MODEL),
    schema: materialDevSchema,
    system:
      "You decide whether a new search result represents a MATERIAL development of an already-known, already-alerted event, versus a duplicate retelling that adds nothing new. Material = a concrete new stage, fact, or change in the event's status. A different outlet covering the same already-known facts is NOT material. Return structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      knownEvent: params.eventLabel,
      newResult: {
        title: params.result.title,
        evidence: (params.result.evidence || "").slice(0, 500),
      },
      instructions: [
        "Set material true only when the new result reports a genuinely new development of the known event.",
        "Set material false when it restates already-known facts, even from a new source or headline.",
      ],
    }),
    temperature: 0,
    ...googleProviderOptions(EVENT_MODEL),
  });
  return { material: object.material === true, reason: object.reason ?? "" };
}

const alertSkepticSchema = z.object({
  refuted: z.boolean(),
  failureMode: z.enum([
    "wrong_subject",
    "listing_surface",
    "not_completed",
    "adjacent_event",
    "query_echo",
    "other",
    "none",
  ]),
  reason: z.string(),
});

export type SkepticVerdict = z.infer<typeof alertSkepticSchema>;

// Adversarial review of an alert candidate — runs ONLY on results the judge
// already marked alert-worthy, so its cost is bounded by the (rare) alert rate.
// The judge that produced a verdict cannot be the one defending it; this is the
// independent second opinion. Callers must fail OPEN: a skeptic outage must not
// silently drop real alerts.
export async function reviewAlert(params: {
  goal: string;
  subject: string;
  criteria: GoalCriteria | null;
  result: {
    title: string;
    url: string;
    snippet: string;
    concept: string;
    judgeAnswer: string;
  };
}): Promise<SkepticVerdict> {
  const { object } = await generateObject({
    model: google(SKEPTIC_MODEL),
    schema: alertSkepticSchema,
    system:
      "You are the adversarial reviewer for a web-monitoring alert that is about to be sent to a paying user. Try to REFUTE it. Refute when any of these hold: (1) wrong_subject — the story's protagonist is a different entity than the monitored subject; the subject being name-dropped, compared against, or listed among others is NOT coverage of the subject; (2) listing_surface — the page is an aggregator, directory, category, calendar, homepage, or feed surface rather than a single story; (3) not_completed — the goal asks for a completed event but this is upcoming, rumored, or planned; (4) adjacent_event — a related-but-different event type (funding news on a release monitor, a partnership on a lawsuit monitor); (5) query_echo — the only evidence is the search query's own wording reflected back in a snippet. UPHOLD the alert (refuted=false, failureMode=none) when the result directly and concretely satisfies the goal — do not refute clear matches on technicalities. The subject's OWN official announcement satisfies an event goal (release, launch, filing, pricing change); never refute an official primary source unless the goal explicitly asks for third-party coverage. Return structured JSON only.",
    prompt: JSON.stringify({
      monitor: {
        goal: params.goal,
        subject: params.subject,
        ...(params.criteria
          ? {
              subjectAliases: params.criteria.subjectAliases,
              excludedSubjects: params.criteria.excludedSubjects,
              mustConcern: params.criteria.mustConcern,
            }
          : {}),
      },
      alertCandidate: {
        title: params.result.title,
        url: params.result.url,
        snippet: params.result.snippet.slice(0, 600),
        judgeConcept: params.result.concept,
        judgeAnswer: params.result.judgeAnswer.slice(0, 800),
      },
    }),
    temperature: 0,
    ...googleProviderOptions(SKEPTIC_MODEL),
  });
  return object;
}

const routerSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      decision: z.enum(["scrape", "skip"]),
      priority: z.number(),
      reason: z.string(),
    }),
  ),
});

export type RouteDecision = {
  id: string;
  decision: "scrape" | "skip";
  priority: number;
  reason: string;
};

// SERP router: decides which results are worth scrape + judge spend, from the
// SERP row alone. The single biggest cost lever on a deep run — every skipped
// candidate saves a full extract-tier scrape. Callers must fail OPEN to
// deterministic top-K routing when this throws.
export async function routeSearchResults(params: {
  goal: string;
  subject: string;
  searchWindow: string;
  maxResults: number;
  candidates: Array<{
    id: string;
    query: string;
    title: string;
    url: string;
    snippet: string;
  }>;
}): Promise<RouteDecision[]> {
  const candidates = params.candidates.slice(0, 50);
  const { object } = await generateObject({
    model: google(ROUTER_MODEL),
    schema: routerSchema,
    system:
      "You route search results for a monitoring product. Decide which indexed results are worth spending scrape/judge credits on. Use only the SERP title, URL, snippet, query, monitor goal, and search window. Return structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      searchWindow: params.searchWindow,
      maxResults: params.maxResults,
      instructions: [
        "Select scrape only when the result could plausibly contain primary evidence or substantive discussion satisfying the monitor goal.",
        "Skip obvious jobs, directories, tag pages, search pages, marketplaces, profiles, irrelevant foreign-language spam, generic tool lists, or pages where the monitored subject appears only as a skill, integration, or incidental keyword.",
        "Do not use keyword overlap alone. Explain the user-facing reason.",
        "Never select more than maxResults.",
      ],
      candidates,
    }),
    temperature: 0,
    ...googleProviderOptions(ROUTER_MODEL),
  });
  const validIds = new Set(candidates.map(c => c.id));
  return object.decisions
    .filter(d => validIds.has(d.id))
    .map(d => ({
      id: d.id,
      decision: d.decision,
      priority: Math.min(1, Math.max(0, d.priority)),
      reason: d.reason.slice(0, 500),
    }));
}

const snippetVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      relevant: z.boolean(),
      alertAction: z.enum(["alert", "watch", "ignore"]),
      freshness: z.enum(["fresh", "stale", "unknown"]),
      sourceQuality: z.enum([
        "first-party",
        "authoritative",
        "unverified",
        "resale",
        "unclear",
      ]),
      concept: z.string(),
      rationale: z.string(),
    }),
  ),
});

export type SnippetVerdict = z.infer<
  typeof snippetVerdictSchema
>["verdicts"][number];

// Standard-depth judging: one batched call over SERP rows, no page fetches.
// (The POC's standard tier judges snippets deterministically; a single batched
// flash call is the backend-appropriate equivalent — same verdict contract as
// the in-scrape judge, ~free, and strictly better than keyword heuristics.)
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
}): Promise<SnippetVerdict[]> {
  if (params.candidates.length === 0) return [];
  const { object } = await generateObject({
    model: google(ROUTER_MODEL),
    schema: snippetVerdictSchema,
    system:
      "You judge search results for a monitoring product using ONLY each result's SERP title, URL, and snippet — you cannot see the page. Be conservative: a snippet is thin evidence, so alertAction alert requires the snippet itself to concretely state a completed event satisfying the goal from a credible source. Query wording echoed in a snippet is not evidence. Competitors, look-alikes, listings, stale or unconfirmed results are watch/ignore. concept: a short reusable label naming the real-world event. Return one verdict per candidate id. Structured JSON only.",
    prompt: JSON.stringify({
      monitor: { goal: params.goal, subject: params.subject },
      searchWindow: params.searchWindow,
      candidates: params.candidates.slice(0, 50),
    }),
    temperature: 0,
    ...googleProviderOptions(ROUTER_MODEL),
  });
  const validIds = new Set(params.candidates.map(c => c.id));
  return object.verdicts.filter(v => validIds.has(v.id));
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
    ...googleProviderOptions(SUMMARY_MODEL),
  });

  return { label: object.label, summary: object.summary };
}

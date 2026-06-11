import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { googleProviderOptions } from "./tuning";

// Compile a monitor goal into a structured criteria artifact that the alert
// verifier can evaluate mechanically. ALL goal-specific knowledge lives in this
// artifact (data); the verifier has no per-goal-type code paths. The artifact is
// keyed to goalVersion, so editing the goal recompiles it automatically.
// Ported from the POC's goal-criteria.js.

const CRITERIA_MODEL =
  process.env.SEARCH_MONITOR_CRITERIA_MODEL ?? "gemini-flash-latest";

export type GoalCriteria = {
  goalVersion: string;
  generatedBy: "deterministic" | "llm";
  // Entity names (and product names, when LLM-compiled) that anchor an alert; empty = not enforced.
  subjectAliases: string[];
  // Content tokens an alert's concept/evidence must overlap; empty = not enforced.
  mustConcern: string[];
  // Entities that must NOT be the story's subject (LLM only — e.g. competitors); empty = not enforced.
  excludedSubjects: string[];
  // Hosts whose own pages should not alert on mention feeds (LLM only); empty = not enforced.
  ownedHosts: string[];
  thirdPartyOnly: boolean;
};

// Words that describe the *instruction*, not the *content* — never criteria.
const INSTRUCTION_WORDS = new Set([
  "about",
  "alert",
  "alerts",
  "all",
  "any",
  "anything",
  "are",
  "article",
  "articles",
  "because",
  "been",
  "between",
  "blog",
  "blogs",
  "can",
  "confirm",
  "could",
  "each",
  "every",
  "evidence",
  "for",
  "fresh",
  "from",
  "get",
  "has",
  "have",
  "her",
  "his",
  "how",
  "into",
  "its",
  "know",
  "let",
  "may",
  "mention",
  "mentioned",
  "mentions",
  "monitor",
  "new",
  "news",
  "not",
  "notify",
  "now",
  "online",
  "only",
  "our",
  "out",
  "page",
  "pages",
  "post",
  "posts",
  "related",
  "requested",
  "result",
  "results",
  "see",
  "should",
  "site",
  "sites",
  "some",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "track",
  "want",
  "watch",
  "web",
  "websites",
  "what",
  "when",
  "whenever",
  "where",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

export function tokenizeContent(text: string | null | undefined): string[] {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !INSTRUCTION_WORDS.has(token));
}

function normalizeForContainment(text: string | null | undefined): string {
  return ` ${String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

export function containsAlias(
  text: string | null | undefined,
  alias: string,
): boolean {
  const haystack = normalizeForContainment(text);
  const needle = normalizeForContainment(alias).trim();
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

// Pure, synchronous, no-network compile. Always available; the LLM compile
// below only ever ADDS knowledge (product aliases, competitors, owned hosts).
export function compileGoalCriteria(params: {
  goal: string;
  subject: string;
  goalVersion: string;
}): GoalCriteria {
  const subject = params.subject.trim();
  const subjectAliases = subject ? [subject] : [];
  const subjectTokens = new Set(tokenizeContent(subject));
  const mustConcern = [
    ...new Set(
      tokenizeContent(params.goal).filter(token => !subjectTokens.has(token)),
    ),
  ];
  return {
    goalVersion: params.goalVersion,
    generatedBy: "deterministic",
    subjectAliases,
    mustConcern,
    excludedSubjects: [],
    ownedHosts: [],
    // Never assume a goal excludes the subject's own sources without the
    // compiler explicitly saying so — vetoing official sources is recall loss.
    thirdPartyOnly: false,
  };
}

const criteriaSchema = z.object({
  subjectAliases: z
    .array(z.string())
    .describe(
      "Every name the monitored subject goes by, INCLUDING its well-known products and brand names. Empty if the goal has no specific subject.",
    ),
  mustConcern: z
    .array(z.string())
    .describe(
      "Single lowercase content words a matching story must plausibly concern. Derived from the goal's topic, not its phrasing. Matching is EXACT string comparison, so include inflection variants explicitly (e.g. release, releases, released, launch, launches, launched).",
    ),
  excludedSubjects: z
    .array(z.string())
    .describe(
      "Entities whose OWN news must not trigger this monitor (e.g. competitors merely name-dropping the subject). Empty when the goal doesn't imply any.",
    ),
  ownedHosts: z
    .array(z.string())
    .describe(
      "Hostnames operated by the subject itself (official site, docs, blog).",
    ),
  thirdPartyOnly: z
    .boolean()
    .describe(
      "true ONLY when the goal asks for third-party coverage of the subject (mentions, press, discussion, reviews) — the subject's own pages then don't satisfy it. false when the subject's own announcements DO satisfy the goal (releases, launches, filings, pricing changes, changelogs).",
    ),
});

export function mergeCompiledCriteria(
  deterministic: GoalCriteria,
  llm: z.infer<typeof criteriaSchema>,
): GoalCriteria {
  const merged: GoalCriteria = {
    ...deterministic,
    generatedBy: "llm",
    subjectAliases: [
      ...new Set([
        ...deterministic.subjectAliases,
        ...llm.subjectAliases.map(s => s.trim()).filter(Boolean),
      ]),
    ],
    mustConcern: [
      ...new Set([
        ...deterministic.mustConcern,
        ...llm.mustConcern.flatMap(tokenizeContent),
      ]),
    ],
    excludedSubjects: [
      ...new Set(llm.excludedSubjects.map(s => s.trim()).filter(Boolean)),
    ],
    ownedHosts: [
      ...new Set(
        llm.ownedHosts
          .map(
            h =>
              String(h ?? "")
                .trim()
                .toLowerCase()
                .replace(/^https?:\/\//, "")
                .replace(/^www\./, "")
                .split("/")[0],
          )
          .filter(Boolean),
      ),
    ],
    thirdPartyOnly: llm.thirdPartyOnly === true,
  };
  // An alias that is also an excluded subject would make every alert
  // contradictory — the alias wins (the compiler over-reached).
  merged.excludedSubjects = merged.excludedSubjects.filter(
    excluded =>
      !merged.subjectAliases.some(
        alias => alias.toLowerCase() === excluded.toLowerCase(),
      ),
  );
  return merged;
}

// LLM enrichment of the deterministic compile. Throws on model failure — the
// caller keeps the deterministic artifact (fail-safe, never blocks the run).
export async function compileGoalCriteriaWithLlm(params: {
  goal: string;
  subject: string;
  queries: string[];
  goalVersion: string;
}): Promise<GoalCriteria> {
  const deterministic = compileGoalCriteria(params);
  const { object } = await generateObject({
    model: google(CRITERIA_MODEL),
    schema: criteriaSchema,
    system:
      "You compile a web-monitoring goal into machine-checkable criteria. The criteria are evaluated with exact string containment and set membership — no interpretation happens later, so be complete (list product names, abbreviations, obvious competitors). Only include entries you are confident about; an empty list disables that check, which is always safe.",
    prompt: JSON.stringify({
      goal: params.goal,
      subject: params.subject,
      queries: params.queries,
    }),
    temperature: 0,
    ...googleProviderOptions(CRITERIA_MODEL),
  });
  return mergeCompiledCriteria(deterministic, object);
}

// Page judge runs INSIDE the Firecrawl scrape (the `json` format) — the verdict comes back
// on document.json. No separate Gemini call: Gemini is only for event-resolution + summary.

// Deliberately minimal: recency and source credibility are folded into the
// judge's single alertAction decision (see buildJudgePrompt) instead of being
// separate gateable fields — fewer fields means fewer self-contradictions and
// a simpler contract. The skeptic remains the independent safety net.
export type SearchVerdict = {
  relevant: boolean;
  alertAction: "alert" | "watch" | "ignore";
  concept: string;
  rationale: string;
};

// JSON schema passed to the scrape `json` format (Firecrawl runs the extraction internally).
export const verdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "alertAction", "concept", "rationale"],
  properties: {
    relevant: { type: "boolean" },
    alertAction: { type: "string", enum: ["alert", "watch", "ignore"] },
    concept: { type: "string" },
    rationale: { type: "string" },
  },
} as const;

export function buildJudgePrompt(
  goal: string,
  subject: string,
  searchWindow: string,
): string {
  return [
    `Monitor goal: ${goal}`,
    subject ? `Monitored subject: ${subject}.` : "",
    `Search window: ${searchWindow}.`,
    "Judge ONLY this page's visible content against the goal, not the query wording.",
    "Set relevant true and alertAction alert only when the page materially satisfies the exact goal, is recent for the search window, and comes from a source credible for this kind of claim — the subject itself or established reporting. Rumors, content farms, syndicated rewrites, competitors, look-alikes, listings, and old or unconfirmed pages are watch/ignore.",
    "concept: a short reusable label naming the real-world event (company/product/event).",
  ]
    .filter(Boolean)
    .join("\n");
}

// Validate/coerce the scrape's document.json into a verdict.
export function parseVerdict(json: unknown): SearchVerdict | null {
  if (!json || typeof json !== "object") return null;
  const v = json as Record<string, unknown>;
  if (typeof v.relevant !== "boolean") return null;
  return {
    relevant: v.relevant,
    alertAction: (["alert", "watch", "ignore"].includes(v.alertAction as string)
      ? v.alertAction
      : "watch") as SearchVerdict["alertAction"],
    concept: typeof v.concept === "string" ? v.concept : "",
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
}

const WINDOW_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export function windowToMs(window: string): number {
  return WINDOW_MS[window] ?? WINDOW_MS["24h"];
}

// "alert" only when relevant, concept-labeled, and the judge asked to alert.
// Recency and credibility live inside the judge's alertAction (see the prompt);
// a notify without a concept can't be event-deduped, so it would re-alert
// forever — concept stays a mechanical requirement.
export function verdictToDecision(
  v: SearchVerdict,
): "notify" | "watch" | "ignore" {
  if (!v.relevant || v.alertAction === "ignore") return "ignore";
  if (v.alertAction === "watch") return "watch";
  if (!v.concept.trim()) return "watch";
  return "notify";
}

// ── Verdict defenses (ported from the POC's assessment.js) ──────────────────
// The judge's own prose is evidence for downstream stages (event resolver,
// verifier, skeptic). Two failure modes need mechanical correction before any
// of that runs: (1) the verdict's boolean contradicts its rationale, and
// (2) the rationale is self-referential meta-claims ("aligns with the monitor
// goal") instead of page facts.

// Does the rationale text negate the verdict? Returns the corrected stance:
// "no" (evidence absent → not relevant), "unclear" (insufficient evidence →
// never alert), or "" (no contradiction).
export function contradictionFromRationale(
  rationale: string,
): "no" | "unclear" | "" {
  const value = String(rationale ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  if (
    /\b(?:not enough|insufficient|too little)\s+evidence\s+(?:to|for)\s+(?:alert|notify|confirm|determine|judge)\b|\bnot\s+enough\s+to\s+(?:alert|notify|confirm|determine|judge)\b/.test(
      value,
    )
  ) {
    return "unclear";
  }
  if (
    /\b(?:does not|doesn't|do not|don't|did not|cannot|can't|fails to|failed to)\s+(?:mention|name|state|show|provide|confirm|establish|include|identify|report|document)\b/.test(
      value,
    )
  ) {
    return "no";
  }
  if (
    /\b(?:mention|subject|topic|brand|company|entity|monitored\s+subject)\b.{0,100}\b(?:is\s+)?(?:not\s+present|absent|missing|not\s+found)\b/.test(
      value,
    ) ||
    /\b(?:not\s+present|absent|missing|not\s+found)\b.{0,80}\b(?:on|from|in)\s+(?:this|the)\s+(?:page|result|article|snippet|content)\b/.test(
      value,
    )
  ) {
    return "no";
  }
  if (
    /\b(?:not|no)\s+(?:an?\s+|the\s+)?(?:direct|exact|matching|concrete|fresh|completed|substantive|user-visible|goal-satisfying)\s+(?:match|event|announcement|release|launch|approval|customer|contract|partnership|deal|acquisition|lawsuit|filing|outage|incident|route|concert|mention)\b/.test(
      value,
    )
  ) {
    return "no";
  }
  if (
    /\b(?:only|just|merely)\s+(?:a\s+)?(?:related|tangential|adjacent|generic|background)\b/.test(
      value,
    )
  ) {
    return "no";
  }
  return "";
}

// Apply contradiction correction to a parsed verdict. A "no" contradiction
// flips relevant off (→ ignore); an "unclear" one caps the action at watch.
export function applyVerdictDefenses(v: SearchVerdict): SearchVerdict {
  const contradiction = contradictionFromRationale(v.rationale);
  if (contradiction === "no" && v.relevant) {
    return { ...v, relevant: false, alertAction: "ignore" };
  }
  if (contradiction === "unclear" && v.alertAction === "alert") {
    return { ...v, alertAction: "watch" };
  }
  return v;
}

// Strip the judge's self-referential meta-claims and field boilerplate from its
// rationale so downstream stages see page facts, not the judge grading itself.
// ("…which aligns with the monitor goal" is not evidence; LLM-side chrome like
// "Related topics: …" is page furniture, not a story.)
export function stripJudgeMetaClaims(text: string): string {
  return String(text ?? "")
    .replace(
      /\b(?:related|more|recommended|popular|trending|latest|similar|also)\s+(?:topics|tags|categories|sections|links|stories|articles|posts|coverage)\s*:?\s*[^.?!]*(?:[.?!]|$)/gi,
      " ",
    )
    .replace(
      /[^.?!]*\b(?:align|aligns|aligned|fit|fits|matched?|matches|satisf(?:y|ies|ied))\s+with\s+(?:the\s+)?monitor\s+goal\b[^.?!]*(?:[.?!]|$)/gi,
      " ",
    )
    .replace(
      /[^.?!]*\b(?:fall|falls|fit|fits|align|aligns|belong|belongs|sit|sits)\s+(?:within|into|under|with)\s+(?:the\s+)?(?:requested\s+)?(?:scope|criteria|categor(?:y|ies)|topic\s+lanes?|lanes?|contexts?)\b[^.?!]*(?:[.?!]|$)/gi,
      " ",
    )
    .replace(
      /[^.?!]*\b(?:fit|fits|fitting|meet|meets|meeting|satisf(?:y|ies|ying|ied)|match(?:es|ing|ed)?)\s+(?:the\s+)?(?:criteria|requirements)\s+(?:for|of)\b[^.?!]*(?:[.?!]|$)/gi,
      " ",
    )
    .replace(/\bSource quality\s+is\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\bFreshness\s+is\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\bReusable topic\s+is\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(
      /\bAlert action\s*:?\s*(?:alert|watch|ignore)\b[^.?!]*(?:[.?!]|$)/gi,
      " ",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

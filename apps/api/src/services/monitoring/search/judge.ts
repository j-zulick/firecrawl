// Page judge runs INSIDE the Firecrawl scrape (the `json` format) — the verdict comes back
// on document.json. No separate Gemini call: Gemini is only for event-resolution + summary.

export type SearchVerdict = {
  relevant: boolean;
  alertAction: "alert" | "watch" | "ignore";
  freshness: "fresh" | "stale" | "unknown";
  sourceQuality:
    | "first-party"
    | "authoritative"
    | "unverified"
    | "resale"
    | "unclear";
  concept: string;
  rationale: string;
};

// JSON schema passed to the scrape `json` format (Firecrawl runs the extraction internally).
export const verdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "relevant",
    "alertAction",
    "freshness",
    "sourceQuality",
    "concept",
    "rationale",
  ],
  properties: {
    relevant: { type: "boolean" },
    alertAction: { type: "string", enum: ["alert", "watch", "ignore"] },
    freshness: { type: "string", enum: ["fresh", "stale", "unknown"] },
    sourceQuality: {
      type: "string",
      enum: ["first-party", "authoritative", "unverified", "resale", "unclear"],
    },
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
    "Set relevant true and alertAction alert only when the page materially satisfies the exact goal and is fresh for the window. Competitors, look-alikes, listings, stale or unconfirmed pages are watch/ignore.",
    "Never pair freshness stale/unknown with alertAction alert.",
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
    freshness: (["fresh", "stale", "unknown"].includes(v.freshness as string)
      ? v.freshness
      : "unknown") as SearchVerdict["freshness"],
    sourceQuality: ([
      "first-party",
      "authoritative",
      "unverified",
      "resale",
      "unclear",
    ].includes(v.sourceQuality as string)
      ? v.sourceQuality
      : "unclear") as SearchVerdict["sourceQuality"],
    concept: typeof v.concept === "string" ? v.concept : "",
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
}

// "alert" only when relevant, fresh, trusted-enough, and the judge asked to alert.
export function verdictToDecision(
  v: SearchVerdict,
): "notify" | "watch" | "ignore" {
  if (!v.relevant || v.alertAction === "ignore") return "ignore";
  if (v.alertAction === "watch") return "watch";
  if (v.freshness !== "fresh") return "watch";
  if (v.sourceQuality === "unverified" || v.sourceQuality === "unclear")
    return "watch";
  return "notify";
}

export type SearchVerdict = {
  relevant: boolean;
  alertAction: "alert" | "watch" | "ignore";
  concept: string;
  rationale: string;
};

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
    "rationale: state only the concrete facts visible on the page that justify your action. Never reference the monitor, goal, or criteria themselves. If the page lacks direct evidence, alertAction must be watch or ignore.",
  ]
    .filter(Boolean)
    .join("\n");
}

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

export function verdictToDecision(
  v: SearchVerdict,
): "notify" | "watch" | "ignore" {
  if (!v.relevant || v.alertAction === "ignore") return "ignore";
  if (v.alertAction === "watch") return "watch";
  if (!v.concept.trim()) return "watch";
  return "notify";
}

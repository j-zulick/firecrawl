// Thinking suppression for search-monitor orchestration calls. Reasoning tokens
// measured at ~85% of LLM output spend on these structured tasks, so every call
// defaults to the lowest thinking the model supports. Gemini 3 models take
// thinkingLevel ("minimal" is the floor — thinking cannot be fully disabled);
// Gemini 2.5-era models (flash-latest, flash-lite) take thinkingBudget, where 0
// disables thinking entirely.
//
// SEARCH_MONITOR_THINKING: "off" (default) | "minimal" | "low" | "medium" |
// "high" | "default" ("default" restores the provider's full-thinking behavior).
const GEMINI_3_LEVELS = ["minimal", "low", "medium", "high"] as const;

type GoogleThinkingOptions = {
  providerOptions?: {
    google: {
      thinkingConfig:
        | { thinkingLevel: (typeof GEMINI_3_LEVELS)[number] }
        | { thinkingBudget: number };
    };
  };
};

export function googleProviderOptions(model: string): GoogleThinkingOptions {
  const setting = String(
    process.env.SEARCH_MONITOR_THINKING ?? "off",
  ).toLowerCase();
  if (setting === "default") {
    return {};
  }
  if (/^gemini-3/.test(model)) {
    const thinkingLevel = (GEMINI_3_LEVELS as readonly string[]).includes(
      setting,
    )
      ? (setting as (typeof GEMINI_3_LEVELS)[number])
      : "minimal";
    return {
      providerOptions: { google: { thinkingConfig: { thinkingLevel } } },
    };
  }
  return {
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
  };
}

// The LLM stages (router, skeptic, criteria enrichment) are optional: without a
// Gemini key they are skipped and deterministic fallbacks run instead, exactly
// like the POC's *FromEnv factories returning null.
export function hasGeminiKey(): boolean {
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
  );
}

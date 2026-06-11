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

export function hasGeminiKey(): boolean {
  return Boolean(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
  );
}

import { createGoogleGenerativeAI } from "@ai-sdk/google";

const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;

type GoogleThinkingOptions = {
  providerOptions?: {
    google: {
      thinkingConfig:
        | { thinkingLevel: (typeof THINKING_LEVELS)[number] }
        | { thinkingBudget: number };
    };
  };
};

export function googleProviderOptions(): GoogleThinkingOptions {
  const setting = String(process.env.SEARCH_MONITOR_THINKING ?? "minimal")
    .trim()
    .toLowerCase();
  if (setting === "default") {
    return {};
  }
  if (/^\d+$/.test(setting)) {
    return {
      providerOptions: {
        google: { thinkingConfig: { thinkingBudget: Number(setting) } },
      },
    };
  }
  const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(setting)
    ? (setting as (typeof THINKING_LEVELS)[number])
    : "minimal";
  return {
    providerOptions: { google: { thinkingConfig: { thinkingLevel } } },
  };
}

function geminiApiKey(): string | undefined {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY;
}

export function hasGeminiKey(): boolean {
  return Boolean(geminiApiKey());
}

export function googleModel(modelId: string) {
  return createGoogleGenerativeAI({ apiKey: geminiApiKey() })(modelId);
}

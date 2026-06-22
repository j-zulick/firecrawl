import { createGoogleGenerativeAI } from "@ai-sdk/google";

type GoogleThinkingOptions = {
  providerOptions: {
    google: { thinkingConfig: { thinkingLevel: "minimal" } };
  };
};

export function googleProviderOptions(): GoogleThinkingOptions {
  return {
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "minimal" } } },
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

import { getModel } from "../../../lib/generic-ai";
import { config } from "../../../config";

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

// Vertex is the preferred provider so usage is traceable via Vertex billing
// labels; the GenAI (Gemini) API is only a fallback when Vertex credentials
// aren't configured (e.g. self-hosted).
function hasVertex(): boolean {
  return Boolean(config.VERTEX_CREDENTIALS);
}

export function hasLlmProvider(): boolean {
  return hasVertex() || Boolean(geminiApiKey());
}

export function googleModel(modelId: string) {
  return getModel(modelId, hasVertex() ? "vertex" : "google");
}

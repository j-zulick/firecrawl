import dotenv from "dotenv";
import { SearchResult } from "../../src/lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";
import { executeWithRetry } from "../lib/retry-utils";

dotenv.config();

function hasResults(results: unknown): results is SearchResult[] {
  return Array.isArray(results) && results.length > 0;
}

async function attemptRequest(
  url: string,
  data: string,
  abort?: AbortSignal,
): Promise<SearchResult[] | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Disable-Cache": "true",
      },
      body: data,
      signal: abort,
    });

    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    logger.error("Request attempt failed:", error);
    Sentry.captureException(error);
  }
  return null;
}

export async function fire_engine_search(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!process.env.FIRE_ENGINE_BETA_URL) {
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${process.env.FIRE_ENGINE_BETA_URL}/search`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}

export async function fireEngineMap(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!process.env.FIRE_ENGINE_BETA_URL) {
    logger.warn(
      "(v1/map Beta) Results might differ from cloud offering currently.",
    );
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${process.env.FIRE_ENGINE_BETA_URL}/map`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}

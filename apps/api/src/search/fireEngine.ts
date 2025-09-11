import dotenv from "dotenv";
import { SearchResult } from "../../src/lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";

dotenv.config();

const RETRY_DELAYS = [500, 1500, 3000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasResults(results: unknown): results is SearchResult[] {
  return Array.isArray(results) && results.length > 0;
}

async function attemptRequest(
  url: string,
  data: string,
  abort?: AbortSignal
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

async function executeWithRetry(
  url: string,
  payload: Record<string, any>,
  abort?: AbortSignal
): Promise<SearchResult[]> {
  const data = JSON.stringify(payload);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) break;

    const responseData = await attemptRequest(url, data, abort);
    
    if (hasResults(responseData)) {
      return responseData;
    }

    // Wait before retry (except on last attempt)
    if (attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
    }
  }

  return [];
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
  return executeWithRetry(url, payload, abort);
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
  return executeWithRetry(url, payload, abort);
}
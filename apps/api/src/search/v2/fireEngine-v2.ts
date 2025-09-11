import dotenv from "dotenv";
import {
  SearchResult,
  SearchV2Response,
  SearchResultType,
} from "../../lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../../lib/logger";
import { executeWithRetry } from "../../lib/retry-utils";

dotenv.config();

function normalizeSearchTypes(
  type?: SearchResultType | SearchResultType[],
): SearchResultType[] {
  if (!type) return ["web"];
  return Array.isArray(type) ? type : [type];
}

function hasCompleteResults(
  response: SearchV2Response,
  requestedTypes: SearchResultType[],
): boolean {
  return requestedTypes.every(type => {
    const results = response[type];
    return Array.isArray(results) && results.length > 0;
  });
}

async function attemptSearch(
  url: string,
  data: string,
  abort?: AbortSignal,
): Promise<SearchV2Response | null> {
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
    logger.error("Search attempt failed:", error);
    Sentry.captureException(error);
  }
  return null;
}

export async function fire_engine_search_v2(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
    type?: SearchResultType | SearchResultType[];
  },
  abort?: AbortSignal,
): Promise<SearchV2Response> {
  if (!process.env.FIRE_ENGINE_BETA_URL) {
    return {};
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
    type: options.type || "web",
  };

  const requestedTypes = normalizeSearchTypes(options.type);
  const url = `${process.env.FIRE_ENGINE_BETA_URL}/v2/search`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchV2Response>(
    () => attemptSearch(url, data, abort),
    (response): response is SearchV2Response =>
      response !== null && hasCompleteResults(response, requestedTypes),
    abort,
  );

  return result ?? {};
}

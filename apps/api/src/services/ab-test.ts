import { ScrapeJobData } from "../types";
import { logger as _logger } from "../lib/logger";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { config } from "../config";
import {
  FireEngineScrapeRequestChromeCDP,
  FireEngineScrapeRequestCommon,
  FireEngineScrapeRequestPlaywright,
  FireEngineScrapeRequestTLSClient,
} from "../scraper/scrapeURL/engines/fire-engine/scrape";
import { MirrorResult, FireEngineResponse } from "./ab-test-comparison";

export function abTestJob(webScraperOptions: ScrapeJobData) {
  // Global A/B test: mirror request to staging /v1/scrape based on SCRAPEURL_AB_RATE
  const abLogger = _logger.child({ method: "ABTestToStaging" });
  try {
    const abRateEnv = config.SCRAPEURL_AB_RATE;
    const abHostEnv = config.SCRAPEURL_AB_HOST;
    const shouldExtendMaxAge = config.SCRAPEURL_AB_EXTEND_MAXAGE;
    const abRate =
      abRateEnv !== undefined ? Math.max(0, Math.min(1, Number(abRateEnv))) : 0;
    const shouldABTest =
      webScraperOptions.mode === "single_urls" &&
      !webScraperOptions.zeroDataRetention &&
      !webScraperOptions.internalOptions?.zeroDataRetention &&
      abRate > 0 &&
      Math.random() <= abRate &&
      abHostEnv &&
      webScraperOptions.internalOptions?.v1Agent === undefined &&
      webScraperOptions.internalOptions?.v1JSONAgent === undefined;
    if (shouldABTest) {
      let timeout = Math.min(
        60000,
        (webScraperOptions.scrapeOptions.timeout ?? 30000) + 10000,
      );

      (async () => {
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => {
          if (abortController) {
            abortController.abort();
          }
        }, timeout);

        try {
          abLogger.info("A/B-testing scrapeURL to staging");
          await robustFetch({
            url: `http://${abHostEnv}/v2/scrape`,
            method: "POST",
            body: {
              url: webScraperOptions.url,
              ...webScraperOptions.scrapeOptions,
              origin: (webScraperOptions.scrapeOptions as any).origin ?? "api",
              ...(shouldExtendMaxAge ? { maxAge: 900000000 } : {}),
            },
            logger: abLogger,
            tryCount: 1,
            ignoreResponse: true,
            mock: null,
            abort: abortController.signal,
          });
          abLogger.info("A/B-testing scrapeURL (staging) request sent");
        } catch (error) {
          abLogger.warn("A/B-testing scrapeURL (staging) failed", { error });
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      })();
    }
  } catch (error) {
    abLogger.warn("Failed to initiate A/B test to staging", { error });
  }
}

export function abTestFireEngine(
  feRequest: FireEngineScrapeRequestCommon &
    (
      | FireEngineScrapeRequestChromeCDP
      | FireEngineScrapeRequestPlaywright
      | FireEngineScrapeRequestTLSClient
    ),
): { shouldCompare: boolean; mirrorPromise: Promise<MirrorResult> | null } {
  const abLogger = _logger.child({ method: "ABTestToStaging" });

  const abRateEnv = config.FIRE_ENGINE_AB_RATE;
  const abUrlEnv = config.FIRE_ENGINE_AB_URL;
  const compareEnabled = config.FIRE_ENGINE_AB_COMPARE_ENABLED;
  const abRate =
    abRateEnv !== undefined ? Math.max(0, Math.min(1, Number(abRateEnv))) : 0;

  const shouldABTest =
    !feRequest.zeroDataRetention &&
    abRate > 0 &&
    Math.random() <= abRate &&
    abUrlEnv;

  if (!shouldABTest) {
    return { shouldCompare: false, mirrorPromise: null };
  }

  const timeout = Math.min(60000, (feRequest.timeout ?? 30000) + 10000);
  const startTime = Date.now();

  const mirrorPromise = (async (): Promise<MirrorResult> => {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeout);

    try {
      abLogger.info("A/B-testing scrapeURL to staging");

      const response = await robustFetch({
        url: `${abUrlEnv}/scrape`,
        method: "POST",
        body: feRequest,
        logger: abLogger,
        tryCount: 1,
        ignoreResponse: false,
        ignoreFailureStatus: true,
        mock: null,
        abort: abortController.signal,
      });

      abLogger.info("A/B-testing scrapeURL (staging) request completed");

      // Extract the fields we need for comparison
      const feResponse: FireEngineResponse | null =
        response &&
        typeof response.content === "string" &&
        typeof response.pageStatusCode === "number" &&
        typeof response.timeTaken === "number"
          ? {
              content: response.content,
              pageStatusCode: response.pageStatusCode,
              timeTaken: response.timeTaken,
            }
          : null;

      return {
        response: feResponse,
        error: feResponse ? null : new Error("Invalid response format"),
        timeTaken: Date.now() - startTime,
      };
    } catch (error) {
      abLogger.warn("A/B-testing scrapeURL (staging) failed", { error });
      return {
        response: null,
        error: error as Error,
        timeTaken: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  })();

  return {
    shouldCompare: compareEnabled,
    mirrorPromise,
  };
}

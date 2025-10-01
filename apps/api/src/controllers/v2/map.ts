import { Response } from "express";
import {
  mapRequestSchema,
  RequestWithAuth,
  MapRequest,
  MapResponse,
  MAX_MAP_LIMIT,
} from "./types";
import { configDotenv } from "dotenv";
import { billTeam } from "../../services/billing/credit_billing";
import { logJob } from "../../services/logging/log_job";
import { logger } from "../../lib/logger";
import { MapTimeoutError } from "../../lib/error";
import { checkPermissions } from "../../lib/permissions";
import { getMapResults, MapResult } from "../../lib/map-utils";

configDotenv();

export async function mapController(
  req: RequestWithAuth<{}, MapResponse, MapRequest>,
  res: Response<MapResponse>,
) {
  const originalRequest = req.body;
  req.body = mapRequestSchema.parse(req.body);

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
    });
  }

  logger.info("Map request", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
  });

  let result: MapResult;
  const abort = new AbortController();
  try {
    result = (await Promise.race([
      getMapResults({
        url: req.body.url,
        search: req.body.search,
        limit: req.body.limit,
        includeSubdomains: req.body.includeSubdomains,
        crawlerOptions: {
          ...req.body,
          sitemap: req.body.sitemap,
        },
        origin: req.body.origin,
        teamId: req.auth.team_id,
        allowExternalLinks: req.body.allowExternalLinks,
        abort: abort.signal,
        mock: req.body.useMock,
        filterByPath: req.body.filterByPath !== false,
        flags: req.acuc?.flags ?? null,
        useIndex: req.body.useIndex,
        location: req.body.location,
      }),
      ...(req.body.timeout !== undefined
        ? [
            new Promise((resolve, reject) =>
              setTimeout(() => {
                abort.abort(new MapTimeoutError());
                reject(new MapTimeoutError());
              }, req.body.timeout),
            ),
          ]
        : []),
    ])) as any;
  } catch (error) {
    if (error instanceof MapTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    } else {
      throw error;
    }
  }

  // Bill the team
  billTeam(
    req.auth.team_id,
    req.acuc?.sub_id ?? undefined,
    1,
    req.acuc?.api_key_id ?? null,
  ).catch(error => {
    logger.error(
      `Failed to bill team ${req.auth.team_id} for 1 credit: ${error}`,
    );
  });

  // Log the job
  const mapCrawlerOptions = {
    search: req.body.search,
    sitemap: req.body.sitemap,
    includeSubdomains: req.body.includeSubdomains,
    ignoreQueryParameters: req.body.ignoreQueryParameters,
    limit: req.body.limit,
    timeout: req.body.timeout,
  };

  const mapScrapeOptions = {
    location: req.body.location,
  };

  logJob({
    job_id: result.job_id,
    success: result.mapResults.length > 0,
    message: "Map completed",
    num_docs: result.mapResults.length,
    docs: result.mapResults,
    time_taken: result.time_taken,
    team_id: req.auth.team_id,
    mode: "map",
    url: req.body.url,
    crawlerOptions: mapCrawlerOptions,
    scrapeOptions: mapScrapeOptions,
    origin: req.body.origin ?? "api",
    integration: req.body.integration,
    num_tokens: 0,
    credits_billed: 1,
    zeroDataRetention: false, // not supported
  });

  const response = {
    success: true as const,
    links: result.mapResults,
  };

  return res.status(200).json(response);
}

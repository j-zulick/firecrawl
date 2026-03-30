import { Response } from "express";
import { RequestWithAuth, ErrorResponse } from "./types";
import { supabase_rr_service } from "../../services/supabase";
import { logger as _logger } from "../../lib/logger";

const ACTIVITY_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const VALID_ENDPOINTS = [
  "scrape",
  "crawl",
  "batch_scrape",
  "search",
  "extract",
  "llmstxt",
  "deep_research",
  "map",
  "agent",
  "browser",
  "interact",
] as const;

type ActivityEndpoint = (typeof VALID_ENDPOINTS)[number];

interface ActivityItem {
  id: string;
  endpoint: ActivityEndpoint;
  api_version: string;
  created_at: string;
  target: string | null;
}

interface ActivityResponse {
  success: true;
  data: ActivityItem[];
  cursor: string | null;
  has_more: boolean;
}

export async function activityController(
  req: RequestWithAuth,
  res: Response<ActivityResponse | ErrorResponse>,
) {
  const logger = _logger.child({
    module: "activity",
    method: "activityController",
    teamId: req.auth.team_id,
  });

  // Parse and validate query params
  const endpoint = req.query.endpoint as string | undefined;
  if (endpoint && !VALID_ENDPOINTS.includes(endpoint as ActivityEndpoint)) {
    return res.status(400).json({
      success: false,
      error: `Invalid endpoint filter. Must be one of: ${VALID_ENDPOINTS.join(", ")}`,
    });
  }

  let limit = parseInt(req.query.limit as string, 10);
  if (isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  }
  limit = Math.min(limit, MAX_LIMIT);

  const cursor = req.query.cursor as string | undefined;

  // Build query
  const windowStart = new Date(
    Date.now() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let query = supabase_rr_service
    .from("requests")
    .select("id, kind, api_version, created_at, target_hint")
    .eq("team_id", req.auth.team_id)
    .gte("created_at", windowStart)
    .order("id", { ascending: false })
    .limit(limit + 1); // fetch one extra to determine has_more

  if (endpoint) {
    query = query.eq("kind", endpoint);
  }

  if (cursor) {
    query = query.lt("id", cursor);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to fetch activity", { error });
    return res.status(500).json({
      success: false,
      error: "Failed to fetch activity.",
    });
  }

  const hasMore = (data?.length ?? 0) > limit;
  const items = hasMore ? data!.slice(0, limit) : (data ?? []);

  const responseData: ActivityItem[] = items.map((row: any) => ({
    id: row.id,
    endpoint: row.kind,
    api_version: row.api_version,
    created_at: row.created_at,
    target: row.target_hint,
  }));

  const nextCursor =
    hasMore && responseData.length > 0
      ? responseData[responseData.length - 1].id
      : null;

  return res.status(200).json({
    success: true,
    data: responseData,
    cursor: nextCursor,
    has_more: hasMore,
  });
}

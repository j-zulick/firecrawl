import { redisEvictConnection } from "./redis";
import { logger as _logger } from "../lib/logger";

/**
 * Lightweight, dependency-free PostHog capture for the API.
 *
 * The API has no PostHog SDK wired up, so we POST directly to the capture
 * endpoint. Everything here is best-effort and fire-and-forget: a missing key
 * or a network error must never affect request handling.
 *
 * Configure via env:
 *   POSTHOG_API_KEY  — project API key (if unset, capture is a no-op)
 *   POSTHOG_HOST     — ingestion host (defaults to https://us.i.posthog.com)
 */
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

export function capturePostHog(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {},
): void {
  if (!POSTHOG_API_KEY) return;

  // Fire-and-forget — do not await in the request path, never throw.
  void (async () => {
    try {
      await fetch(`${POSTHOG_HOST.replace(/\/$/, "")}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_API_KEY,
          event,
          distinct_id: distinctId,
          properties,
        }),
      });
    } catch (error) {
      _logger.debug("PostHog capture failed", { module: "posthog", event, error });
    }
  })();
}

/** Normalized request surface, derived from the free-form `origin` field. */
export type RequestSurface =
  | "playground"
  | "sdk"
  | "mcp"
  | "cli"
  | "api"
  | "monitor"
  | "other";

/**
 * Map the free-form `origin` request field to a coarse surface category.
 *
 * `origin` is client-set (defaults to "api"); these are the values observed in
 * practice. NOTE: confirm the exact strings sent by firecrawl-mcp and
 * firecrawl-cli — adjust the prefixes below if they differ.
 */
export function originToSurface(origin?: string | null): RequestSurface {
  const o = (origin ?? "").toLowerCase();
  if (o === "website" || o.includes("playground")) return "playground";
  if (o.startsWith("mcp")) return "mcp";
  if (o.startsWith("cli") || o.includes("firecrawl-cli")) return "cli";
  if (o.includes("sdk")) return "sdk"; // e.g. "api-sdk"
  if (o.startsWith("monitor")) return "monitor";
  if (o === "api") return "api";
  return "other";
}

/**
 * Emit a one-time `api_surface_first_used` event the first time a team makes a
 * request from a given surface (playground / sdk / mcp / cli / api / ...).
 *
 * Dedup is a Redis SET NX (no DB change): the key is written once per
 * (team, surface), so the event fires at most once per pair. Volume is bounded
 * by #teams × #surfaces, independent of total request volume.
 *
 * Durability caveat: the marker lives on the evict Redis connection, so an
 * eviction / flush can let the event re-fire for a team. That is acceptable for
 * a milestone (PostHog `first_time_for_user` / min-timestamp analysis dedupes
 * downstream). If exactly-once is ever required, back this with a Postgres
 * table keyed on (team_id, surface) instead.
 *
 * Fire-and-forget: never awaited in the request path, never throws.
 */
export function trackFirstSurfaceUse(args: {
  teamId: string;
  origin?: string | null;
  kind: string;
  apiVersion: string;
}): void {
  const { teamId, origin, kind, apiVersion } = args;

  // Skip anonymous / preview traffic — not a real team milestone.
  if (!teamId || teamId === "preview" || teamId.startsWith("preview_")) return;

  void (async () => {
    try {
      const surface = originToSurface(origin);
      const key = `firecrawl:surface_first:${teamId}:${surface}`;
      // SET key 1 NX → "OK" only the very first time; null otherwise. Atomic.
      const isFirst = await redisEvictConnection.set(key, "1", "NX");
      if (isFirst !== "OK") return;

      capturePostHog("api_surface_first_used", teamId, {
        surface,
        raw_origin: origin ?? null,
        kind,
        api_version: apiVersion,
        team_id: teamId,
        // Associate with the PostHog `team` group for team-level analysis.
        $groups: { team: teamId },
      });
    } catch (error) {
      _logger.debug("trackFirstSurfaceUse failed", {
        module: "posthog",
        teamId,
        error,
      });
    }
  })();
}

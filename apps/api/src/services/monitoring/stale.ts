import type { MonitorCheckRow } from "./types";

export const MONITOR_CHECK_STALE_TIMEOUT_MS = 60 * 60 * 1000;
// Search checks run inline and finish in minutes; a stranded one should self-heal quickly, not look dead for an hour.
const MONITOR_SEARCH_CHECK_STALE_TIMEOUT_MS = 10 * 60 * 1000;
export const MONITOR_CHECK_STALE_ERROR =
  "Monitor check exceeded the running timeout.";

// Short timeout only when EVERY target is search; a mixed monitor's crawl/scrape fan-out legitimately runs for many minutes.
function isSearchOnlyCheck(check: { target_results?: unknown }): boolean {
  const targetResults = check.target_results;
  if (!Array.isArray(targetResults) || targetResults.length === 0) return false;
  return targetResults.every(
    tr =>
      tr != null &&
      typeof tr === "object" &&
      (tr as { type?: unknown }).type === "search",
  );
}

export function monitorCheckStaleTimeoutMs(check: {
  target_results?: unknown;
}): number {
  return isSearchOnlyCheck(check)
    ? MONITOR_SEARCH_CHECK_STALE_TIMEOUT_MS
    : MONITOR_CHECK_STALE_TIMEOUT_MS;
}

export function isMonitorCheckStale(
  check: Pick<MonitorCheckRow, "started_at" | "updated_at" | "created_at"> & {
    target_results?: unknown;
  },
  now: Date = new Date(),
): boolean {
  const startedAt = check.started_at ?? check.updated_at ?? check.created_at;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return false;
  return now.getTime() - startedAtMs >= monitorCheckStaleTimeoutMs(check);
}

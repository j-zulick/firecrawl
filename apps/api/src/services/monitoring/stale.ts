import type { MonitorCheckRow } from "./types";

export const MONITOR_CHECK_STALE_TIMEOUT_MS = 60 * 60 * 1000;
// Search checks run their whole search+scrape+judge inline and realistically
// finish in seconds-to-low-minutes. A stranded one (crash between the inline
// work and the ack) should self-heal quickly rather than look dead for an hour.
const MONITOR_SEARCH_CHECK_STALE_TIMEOUT_MS = 10 * 60 * 1000;
export const MONITOR_CHECK_STALE_ERROR =
  "Monitor check exceeded the running timeout.";

// A check is a search check if any of its target runs is of type "search".
function isSearchCheck(check: { target_results?: unknown }): boolean {
  const targetResults = check.target_results;
  if (!Array.isArray(targetResults)) return false;
  return targetResults.some(
    tr =>
      tr != null &&
      typeof tr === "object" &&
      (tr as { type?: unknown }).type === "search",
  );
}

export function monitorCheckStaleTimeoutMs(check: {
  target_results?: unknown;
}): number {
  return isSearchCheck(check)
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

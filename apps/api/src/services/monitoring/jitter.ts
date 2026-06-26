import { createHash } from "crypto";

// Cap the spread at 30 min: enough that hourly monitors fan out across :00-:30
// (instead of piling at :00 and starving the consumer) while a daily/weekly cron
// still fires within tens of minutes of its intended time. Sub-hourly intervals
// stay bounded by intervalMs/2 below.
const MAX_JITTER_MS = 30 * 60 * 1000;

export function monitorJitterOffsetMs(
  monitorId: string,
  intervalMs: number,
): number {
  const jitterMaxMs = Math.min(Math.floor(intervalMs / 2), MAX_JITTER_MS);
  if (jitterMaxMs <= 0) return 0;
  const hash = createHash("sha256").update(monitorId).digest();
  return hash.readUInt32BE(0) % jitterMaxMs;
}

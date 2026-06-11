import { canonicalizeUrl } from "./dedupe";
import type { KnownPage } from "./run";
import type { KnownEvent } from "./llm";

// Search verdict status → the page-status enum the reconciler tallies (new/same/error).
export function searchStatusToPageStatus(
  status: string,
): "same" | "new" | "changed" | "removed" | "error" {
  if (status === "alert") return "new";
  if (status === "skipped") return "error";
  return "same";
}

// True for statuses that came from a successful scrape+judge (used for credit attribution).
export function searchPageWasScraped(status: string): boolean {
  return status === "alert" || status === "watching" || status === "ignored";
}

type PriorPage = {
  url: string;
  metadata: unknown | null;
  updated_at?: string;
  last_status?: string;
};

// Rebuild dedup memory + event index from prior pages. Fingerprints load regardless of
// goalVersion (the runner gates freshness); events only carry the current goalVersion.
export function reconstructKnownState(
  priorPages: PriorPage[],
  goalVersion: string,
): { knownPages: Map<string, KnownPage>; knownEvents: KnownEvent[] } {
  const knownPages = new Map<string, KnownPage>();
  const eventsByKey = new Map<string, KnownEvent & { lastSeenAt: string }>();
  for (const page of priorPages) {
    const meta = (page.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof meta.fingerprint === "string" &&
      typeof meta.goalVersion === "string"
    ) {
      knownPages.set(canonicalizeUrl(page.url), {
        fingerprint: meta.fingerprint,
        goalVersion: meta.goalVersion,
        lastCheckedAt: page.updated_at,
        lastStatus: page.last_status,
      });
    }
    if (meta.goalVersion === goalVersion && typeof meta.eventKey === "string") {
      const existing = eventsByKey.get(meta.eventKey);
      const seenAt = page.updated_at ?? "";
      // Event state is stamped per alerting page; aggregate across pages:
      // satisfiedAt = earliest stamp (first alert), alertCount = highest stamp
      // (each alert writes prior+1, so max is the true count even when several
      // pages of the same event carry older stamps).
      const satisfiedAt =
        typeof meta.eventSatisfiedAt === "string"
          ? meta.eventSatisfiedAt
          : undefined;
      const alertCount =
        typeof meta.eventAlertCount === "number"
          ? meta.eventAlertCount
          : undefined;
      if (!existing) {
        eventsByKey.set(meta.eventKey, {
          key: meta.eventKey,
          label:
            typeof meta.eventLabel === "string"
              ? meta.eventLabel
              : meta.eventKey,
          lastSeenAt: seenAt,
          ...(satisfiedAt ? { satisfiedAt } : {}),
          ...(alertCount !== undefined ? { alertCount } : {}),
        });
      } else {
        if (seenAt > existing.lastSeenAt) {
          existing.lastSeenAt = seenAt;
        }
        if (
          satisfiedAt &&
          (!existing.satisfiedAt || satisfiedAt < existing.satisfiedAt)
        ) {
          existing.satisfiedAt = satisfiedAt;
        }
        if (
          alertCount !== undefined &&
          (existing.alertCount === undefined ||
            alertCount > existing.alertCount)
        ) {
          existing.alertCount = alertCount;
        }
      }
    }
  }
  // Most-recently-seen first: the event resolver truncates this list to ~20
  // candidates, and active stories must stay inside that window or every new
  // article about them mints a duplicate event (and a duplicate alert).
  const knownEvents = [...eventsByKey.values()]
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
    .map(({ lastSeenAt: _ignored, ...event }) => event);
  return { knownPages, knownEvents };
}

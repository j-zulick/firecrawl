import { canonicalizeUrl } from "./dedupe";
import type { KnownPage } from "./run";
import type { KnownEvent } from "./llm";

// Search verdict status → the monitor page-status enum the reconciler counts.
// alert = a genuinely-new meaningful match (new); seen/watching/ignored = no new alert (same);
// a failed scrape = error. This keeps search runs visible in the same new/same/error tallies.
export function searchStatusToPageStatus(
  status: string,
): "same" | "new" | "changed" | "removed" | "error" {
  if (status === "alert") return "new";
  if (status === "skipped") return "error";
  return "same";
}

// A scraped search result ran a json verdict extraction; already-seen results skip the scrape.
// The runner maps these flags onto the canonical credit estimator (no new constants here).
export function searchPageWasScraped(status: string): boolean {
  return status === "alert" || status === "watching" || status === "ignored";
}

type PriorPage = { url: string; metadata: unknown | null };

// Rebuild the per-URL dedup memory and the event index from prior monitor_pages of this target.
// Stale-goal fingerprints are still loaded (the runner's goalVersion gate decides freshness),
// but the event index only carries events from the CURRENT goalVersion so a goal change starts clean.
export function reconstructKnownState(
  priorPages: PriorPage[],
  goalVersion: string,
): { knownPages: Map<string, KnownPage>; knownEvents: KnownEvent[] } {
  const knownPages = new Map<string, KnownPage>();
  const eventsByKey = new Map<string, KnownEvent>();
  for (const page of priorPages) {
    const meta = (page.metadata ?? {}) as Record<string, unknown>;
    if (
      typeof meta.fingerprint === "string" &&
      typeof meta.goalVersion === "string"
    ) {
      knownPages.set(canonicalizeUrl(page.url), {
        fingerprint: meta.fingerprint,
        goalVersion: meta.goalVersion,
      });
    }
    if (
      meta.goalVersion === goalVersion &&
      typeof meta.eventKey === "string" &&
      !eventsByKey.has(meta.eventKey)
    ) {
      eventsByKey.set(meta.eventKey, {
        key: meta.eventKey,
        label:
          typeof meta.eventLabel === "string" ? meta.eventLabel : meta.eventKey,
      });
    }
  }
  return { knownPages, knownEvents: [...eventsByKey.values()] };
}

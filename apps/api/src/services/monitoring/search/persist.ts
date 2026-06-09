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
        lastCheckedAt: page.updated_at,
        lastStatus: page.last_status,
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

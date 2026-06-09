import { createHash } from "node:crypto";
import { normalizeUrl } from "../../../lib/canonical-url";

// Canonical key for URL dedup (reuses prod normalization; pair with hashMonitorUrl for url_hash).
export function canonicalizeUrl(raw: string): string {
  return normalizeUrl(String(raw || "")).toLowerCase();
}

// Stable pre-scrape fingerprint from SERP fields only (title + snippet). We never hash scraped
// page content — it churns between scrapes and would falsely re-flag the same source as changed.
export function stableSerpFingerprint(src: {
  url?: string;
  title?: string;
  snippet?: string;
  description?: string;
}): string {
  const text = [src.title, src.snippet ?? src.description]
    .filter(Boolean)
    .join("\n")
    .trim();
  return createHash("sha256")
    .update(text || canonicalizeUrl(src.url ?? ""))
    .digest("hex")
    .slice(0, 24);
}

import { createHash } from "node:crypto";
import { normalizeUrl } from "../../../lib/canonical-url";

export function canonicalizeUrl(raw: string): string {
  return normalizeUrl(String(raw || "")).toLowerCase();
}

export function computeGoalVersion(
  goal: string | null,
  subject: string | null,
  queries: string[],
): string {
  return createHash("sha256")
    .update([goal ?? "", subject ?? "", ...[...queries].sort()].join(" "))
    .digest("hex")
    .slice(0, 16);
}

export function stableSerpFingerprint(src: {
  url?: string;
  title?: string;
  snippet?: string;
  description?: string;
}): string {
  // A search result is identified by its canonical URL. Snippets and titles drift
  // between searches (engines reword/truncate them), so hashing that text would
  // re-flag the same URL as "changed" every check — causing the same result to be
  // re-judged and re-billed. Keying on the URL keeps already-seen results free.
  return createHash("sha256")
    .update(canonicalizeUrl(src.url ?? ""))
    .digest("hex")
    .slice(0, 24);
}

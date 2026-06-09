import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { search } from "../../../search";
import { scrapeURL } from "../../../scraper/scrapeURL";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { hashMonitorUrl } from "../store";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import {
  buildJudgePrompt,
  parseVerdict,
  verdictJsonSchema,
  verdictToDecision,
} from "./judge";
import { resolveEvent, summarizeRun, type KnownEvent } from "./llm";

// Unified schedule/window step → Firecrawl tbs window.
function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w"; // 7d
}

function slugifyEvent(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "event"
  );
}

export type SearchTargetInput = {
  id: string;
  queries: string[];
  searchWindow: string;
  alertMode: "first_match" | "every_new_result";
  includeDomains?: string[];
  maxResults: number;
};

// Per-URL dedup memory, reconstructed from monitor_pages.metadata by the runner. Stale-goal
// rows are ignored (goalVersion gate) so a changed goal re-evaluates instead of staying quiet.
export type KnownPage = {
  fingerprint: string;
  goalVersion: string;
};

export type SearchSource = {
  url: string;
  title: string;
  status: "alert" | "already_seen" | "watching" | "ignored" | "skipped";
  alertAction?: string;
  freshness?: string;
  sourceQuality?: string;
  concept?: string;
  eventKey?: string;
  rationale?: string;
};

export type SearchTargetRunResult = {
  targetId: string;
  type: "search";
  resultCount: number;
  pagesChecked: number;
  skipped: number;
  meaningful: number;
  matches: number; // new alerts this run
  summary: string;
  sources: SearchSource[];
  // → upsert into monitor_pages; metadata carries fingerprint, goalVersion, verdict, and
  // (for alert/already_seen) eventKey+eventLabel. The event index is reconstructed from
  // these page rows — no separate event table/column.
  pageUpserts: Array<{
    url: string;
    urlHash: Buffer;
    status: string;
    metadata: Record<string, unknown>;
  }>;
};

export async function runSearchTarget(params: {
  monitor: { id: string; teamId: string; goal: string | null; subject: string };
  target: SearchTargetInput;
  goalVersion: string;
  // Same-goalVersion dedup memory + events, derived from monitor_pages by the runner.
  knownPages: Map<string, KnownPage>;
  knownEvents: KnownEvent[];
  zeroDataRetention: boolean;
  logger: Logger;
}): Promise<SearchTargetRunResult> {
  const { target, knownPages, goalVersion, logger } = params;

  // P0(#4): a search monitor cannot judge without a goal.
  const goal = params.monitor.goal?.trim();
  if (!goal) {
    throw new Error("search monitor target requires a non-empty monitor goal");
  }
  const subject = params.monitor.subject ?? "";
  const teamId = params.monitor.teamId;

  const tbs = windowToTbs(target.searchWindow);
  const events: KnownEvent[] = [...params.knownEvents];
  const satisfied = new Set(events.map(e => e.key)); // first_match suppression set
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;

  // 1. Search each query; flatten + dedup by canonical URL within this run.
  const seenThisRun = new Set<string>();
  const candidates: Array<{ url: string; title: string; description: string }> =
    [];
  for (const query of target.queries) {
    const results = await search({
      query,
      logger,
      num_results: target.maxResults,
      tbs,
    });
    for (const r of results) {
      if (!r.url) continue;
      const canonical = canonicalizeUrl(r.url);
      if (seenThisRun.has(canonical)) continue;
      seenThisRun.add(canonical);
      candidates.push({ url: r.url, title: r.title, description: r.description });
    }
  }
  resultCount = candidates.length;

  // 2. Per candidate: dedup → (judge if new/changed) → decide → event-resolve.
  for (const c of candidates.slice(0, target.maxResults)) {
    const canonical = canonicalizeUrl(c.url);
    const fingerprint = stableSerpFingerprint({
      url: c.url,
      title: c.title,
      snippet: c.description,
    });
    const known = knownPages.get(canonical);
    // P0(#1): a page judged under a different goal is stale — treat it as new.
    const knownCurrent = known && known.goalVersion === goalVersion ? known : undefined;
    const isNewOrChanged =
      !knownCurrent || knownCurrent.fingerprint !== fingerprint;

    // Already-seen + unchanged under the current goal → reuse, no scrape/judge/LLM.
    if (!isNewOrChanged) {
      sources.push({ url: c.url, title: c.title, status: "already_seen" });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "already_seen",
        metadata: { fingerprint, goalVersion },
      });
      continue;
    }

    // Judge the page INSIDE the scrape via the `json` format — Firecrawl runs the extraction
    // (the page judge), the verdict comes back on document.json. No separate Gemini call.
    let res;
    try {
      res = await scrapeURL(
        "search-monitor;" + uuidv7(),
        c.url,
        scrapeOptions.parse({
          formats: [
            {
              type: "json",
              schema: verdictJsonSchema,
              prompt: buildJudgePrompt(goal, subject, target.searchWindow),
            },
          ],
          timeout: 20000,
        }),
        { teamId, zeroDataRetention: params.zeroDataRetention },
        new CostTracking(),
      );
    } catch (error) {
      logger.warn("search monitor scrape threw", { url: c.url, error });
      skipped += 1;
      sources.push({ url: c.url, title: c.title, status: "skipped" });
      continue;
    }

    // P0(#2): scrapeURL returns a discriminated result — handle the failure arm.
    if (!res.success) {
      logger.warn("search monitor scrape failed", { url: c.url });
      skipped += 1;
      sources.push({ url: c.url, title: c.title, status: "skipped" });
      continue;
    }
    pagesChecked += 1;

    const verdict = parseVerdict(res.document.json);
    if (!verdict) {
      skipped += 1;
      sources.push({ url: c.url, title: c.title, status: "skipped" });
      continue;
    }

    const decision = verdictToDecision(verdict);
    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: verdict.alertAction,
      freshness: verdict.freshness,
      sourceQuality: verdict.sourceQuality,
      concept: verdict.concept,
      rationale: verdict.rationale,
    };

    if (decision === "ignore") {
      sources.push({ url: c.url, title: c.title, status: "ignored", ...baseMeta });
      pageUpserts.push({ url: canonical, urlHash: hashMonitorUrl(canonical), status: "ignored", metadata: baseMeta });
      continue;
    }
    if (decision === "watch") {
      sources.push({ url: c.url, title: c.title, status: "watching", ...baseMeta });
      pageUpserts.push({ url: canonical, urlHash: hashMonitorUrl(canonical), status: "watching", metadata: baseMeta });
      continue;
    }

    // notify → resolve the real-world event against recent known events.
    const resolution = await resolveEvent({
      goal,
      subject,
      result: { title: c.title, url: c.url, evidence: verdict.rationale },
      candidates: events,
    });
    const eventKey =
      resolution.matchedKey ??
      (resolution.label ? slugifyEvent(resolution.label) : slugifyEvent(verdict.concept));
    const eventLabel =
      events.find(e => e.key === eventKey)?.label ||
      resolution.label ||
      verdict.concept;

    const alreadySatisfied =
      target.alertMode === "first_match" && satisfied.has(eventKey);
    const eventMeta = { ...baseMeta, eventKey, eventLabel };

    if (alreadySatisfied) {
      sources.push({ url: c.url, title: c.title, status: "already_seen", eventKey, ...baseMeta });
      pageUpserts.push({ url: canonical, urlHash: hashMonitorUrl(canonical), status: "already_seen", metadata: eventMeta });
      continue;
    }

    // New, meaningful, not-yet-satisfied → alert.
    matches += 1;
    satisfied.add(eventKey);
    if (!events.some(e => e.key === eventKey)) {
      events.push({ key: eventKey, label: eventLabel });
    }
    sources.push({ url: c.url, title: c.title, status: "alert", eventKey, ...baseMeta });
    pageUpserts.push({ url: canonical, urlHash: hashMonitorUrl(canonical), status: "alert", metadata: eventMeta });
  }

  const meaningful = sources.filter(
    s => s.status === "alert" || s.status === "already_seen",
  ).length;

  let summary = "";
  if (matches > 0) {
    const out = await summarizeRun({
      goal,
      subject,
      evidence: sources
        .filter(s => s.status === "alert")
        .map(s => ({ title: s.title, url: s.url, rationale: s.rationale ?? "" })),
    });
    summary = out.summary;
  }

  return {
    targetId: target.id,
    type: "search",
    resultCount,
    pagesChecked,
    skipped,
    meaningful,
    matches,
    summary,
    sources,
    pageUpserts,
  };
}

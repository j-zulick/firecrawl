import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { search } from "../../../search";
import { buildSearchQuery } from "../../../lib/search-query-builder";
import { scrapeURL } from "../../../scraper/scrapeURL";
import { scrapeOptions } from "../../../controllers/v2/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { hashMonitorUrl } from "../store";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import {
  buildJudgePrompt,
  freshnessFromDate,
  parseVerdict,
  verdictJsonSchema,
  verdictToDecision,
  windowToMs,
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

type SearchTargetInput = {
  id: string;
  queries: string[];
  searchWindow: string;
  alertMode: "first_match" | "every_new_result";
  includeDomains?: string[];
  excludeDomains?: string[];
  // Re-judge a still-live result (last status alert/watching) when its last check is older than
  // this window, even if the SERP snippet is unchanged — catches content updates SERP text misses.
  recheckAfter?: string;
  maxResults: number;
};

export type KnownPage = {
  fingerprint: string;
  goalVersion: string;
  lastCheckedAt?: string;
  lastStatus?: string;
};

type SearchSource = {
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

type SearchTargetRunResult = {
  targetId: string;
  type: "search";
  resultCount: number;
  pagesChecked: number;
  skipped: number;
  meaningful: number;
  matches: number; // new alerts this run
  summary: string;
  sources: SearchSource[];
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
  knownPages: Map<string, KnownPage>;
  knownEvents: KnownEvent[];
  zeroDataRetention: boolean;
  logger: Logger;
}): Promise<SearchTargetRunResult> {
  const { target, knownPages, goalVersion, logger } = params;

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
    // Scope to domains the same way the v2 search API does (site:/-site: operators).
    const { query: scopedQuery } = buildSearchQuery(query, undefined, {
      includeDomains: target.includeDomains,
      excludeDomains: target.excludeDomains,
    });
    const results = await search({
      query: scopedQuery,
      logger,
      num_results: target.maxResults,
      tbs,
    });
    for (const r of results) {
      if (!r.url) continue;
      const canonical = canonicalizeUrl(r.url);
      if (seenThisRun.has(canonical)) continue;
      seenThisRun.add(canonical);
      candidates.push({
        url: r.url,
        title: r.title,
        description: r.description,
      });
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
    const knownCurrent =
      known && known.goalVersion === goalVersion ? known : undefined;
    // Re-judge a still-live result on a cadence even if its SERP snippet is unchanged.
    const recheckMs = target.recheckAfter ? windowToMs(target.recheckAfter) : 0;
    const isLive =
      knownCurrent?.lastStatus === "alert" ||
      knownCurrent?.lastStatus === "watching";
    const dueForRecheck = Boolean(
      recheckMs &&
        isLive &&
        knownCurrent?.lastCheckedAt &&
        Date.now() - Date.parse(knownCurrent.lastCheckedAt) > recheckMs,
    );
    const isNewOrChanged =
      !knownCurrent ||
      knownCurrent.fingerprint !== fingerprint ||
      dueForRecheck;

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

    // Judge in-scrape via the json format; verdict returns on document.json.
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

    // Prefer a real publish date over the LLM's freshness guess (freshness is an alert veto).
    const realDate =
      res.document.metadata?.publishedTime ??
      res.document.metadata?.modifiedTime ??
      null;
    const dateFreshness = freshnessFromDate(
      realDate,
      target.searchWindow,
      Date.now(),
    );
    const effectiveVerdict = dateFreshness
      ? { ...verdict, freshness: dateFreshness }
      : verdict;

    const decision = verdictToDecision(effectiveVerdict);
    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: effectiveVerdict.alertAction,
      freshness: effectiveVerdict.freshness,
      freshnessSource: dateFreshness ? "date" : "llm",
      publishedAt: realDate,
      sourceQuality: effectiveVerdict.sourceQuality,
      concept: effectiveVerdict.concept,
      rationale: effectiveVerdict.rationale,
    };

    if (decision === "ignore") {
      sources.push({
        url: c.url,
        title: c.title,
        status: "ignored",
        ...baseMeta,
      });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "ignored",
        metadata: baseMeta,
      });
      continue;
    }
    if (decision === "watch") {
      sources.push({
        url: c.url,
        title: c.title,
        status: "watching",
        ...baseMeta,
      });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "watching",
        metadata: baseMeta,
      });
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
      (resolution.label
        ? slugifyEvent(resolution.label)
        : slugifyEvent(verdict.concept));
    const eventLabel =
      events.find(e => e.key === eventKey)?.label ||
      resolution.label ||
      verdict.concept;

    const alreadySatisfied =
      target.alertMode === "first_match" && satisfied.has(eventKey);
    const eventMeta = { ...baseMeta, eventKey, eventLabel };

    if (alreadySatisfied) {
      sources.push({
        url: c.url,
        title: c.title,
        status: "already_seen",
        eventKey,
        ...baseMeta,
      });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "already_seen",
        metadata: eventMeta,
      });
      continue;
    }

    // New, meaningful, not-yet-satisfied → alert.
    matches += 1;
    satisfied.add(eventKey);
    if (!events.some(e => e.key === eventKey)) {
      events.push({ key: eventKey, label: eventLabel });
    }
    sources.push({
      url: c.url,
      title: c.title,
      status: "alert",
      eventKey,
      ...baseMeta,
    });
    pageUpserts.push({
      url: canonical,
      urlHash: hashMonitorUrl(canonical),
      status: "alert",
      metadata: eventMeta,
    });
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
        .map(s => ({
          title: s.title,
          url: s.url,
          rationale: s.rationale ?? "",
        })),
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

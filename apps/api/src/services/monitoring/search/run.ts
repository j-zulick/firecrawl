import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { search } from "../../../search/v2";
import { buildSearchQuery } from "../../../lib/search-query-builder";
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
  windowToMs,
  type SearchVerdict,
} from "./judge";
import {
  judgeMaterialDevelopment,
  judgeSnippets,
  resolveEvent,
  reviewAlert,
  routeSearchResults,
  summarizeRun,
  type KnownEvent,
  type RouteDecision,
  type SkepticVerdict,
  type SnippetVerdict,
} from "./llm";
import {
  compileGoalCriteria,
  compileGoalCriteriaWithLlm,
  type GoalCriteria,
} from "./criteria";
import {
  verifyAlertCandidate,
  type VerificationResult,
  type VerifyEvidence,
} from "./verify";
import { hasGeminiKey } from "./tuning";

// Flat credits per result the judge evaluates (scraped + judged in deep mode).
// Deterministic and known at check time — no token/at-cost math.
export const JUDGE_CREDITS_PER_RESULT = 5;

function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w";
}

// The provider rate-limits near-simultaneous identical queries and may answer
// with a clean HTTP 200 empty body. Retry empty responses with backoff; a
// genuinely-empty query just exhausts attempts and returns empty cleanly.
const SEARCH_RETRY_BACKOFF_MS = [400, 1200] as const;

async function searchWithRetry(
  args: Parameters<typeof search>[0],
  logger: Logger,
): Promise<Awaited<ReturnType<typeof search>>> {
  const maxAttempts = SEARCH_RETRY_BACKOFF_MS.length + 1;
  let lastResponse: Awaited<ReturnType<typeof search>> = {};

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await search(args);
    lastResponse = response;

    const hasResults = (response.web?.length ?? 0) > 0;
    if (hasResults) return response;

    const isLastAttempt = attempt === maxAttempts - 1;
    if (!isLastAttempt) {
      const base = SEARCH_RETRY_BACKOFF_MS[attempt];
      const jitter = Math.floor(Math.random() * 250);
      logger.info("search monitor query empty; retrying", {
        query: args.query,
        attempt: attempt + 1,
        backoffMs: base + jitter,
      });
      await new Promise(r => setTimeout(r, base + jitter));
      continue;
    }
  }

  return lastResponse;
}

function isExcludedDomain(
  url: string,
  excludeDomains: string[] | undefined,
): boolean {
  if (!excludeDomains?.length) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return excludeDomains.some(domain => {
    const normalized = domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    return (
      normalized.length > 0 &&
      (host === normalized || host.endsWith(`.${normalized}`))
    );
  });
}

type SearchTargetInput = {
  id: string;
  queries: string[];
  searchWindow: string;
  alertMode: "first_match" | "every_new_result" | "material_dev";
  includeDomains?: string[];
  excludeDomains?: string[];
  recheckAfter?: string;
  maxResults: number;
  depth?: "raw" | "standard" | "deep";
};

export type KnownPage = {
  fingerprint: string;
  goalVersion: string;
  lastCheckedAt?: string;
  lastStatus?: string;
  // Carried through so unchanged-page upserts don't wipe event/verdict fields
  // persisted by earlier runs.
  metadata?: Record<string, unknown>;
};

type SearchSource = {
  url: string;
  title: string;
  status: "alert" | "already_seen" | "watching" | "ignored" | "skipped";
  alertAction?: string;
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
  matches: number;
  summary: string;
  // Reserved provider-level degraded signal. The public search() helper swallows
  // provider errors into an empty result, so the monitor cannot tell a real
  // failure from a genuine no-results without reaching into core search; this
  // therefore stays false. Kept for the check shape and possible future use.
  searchDegraded: boolean;
  // True when the deep (scrape+judge) path was expected to evaluate results but
  // evaluated ~none BECAUSE the per-result scrapes failed/timed out. A judged check that
  // completes with 0 pages / 0 judged because every scrape errored otherwise
  // looks identical to "nothing new"; this flags it so it isn't read as clean.
  // Conservative: NOT set when search legitimately returned 0 results, and NOT
  // set when the judge legitimately ignored everything (resultsJudged > 0).
  judgeDegraded: boolean;
  // Human-readable explanation when judgeDegraded is set, surfaced onto the
  // check/summary.
  degradedReason: string | null;
  sources: SearchSource[];
  // Search() call credits (≈2 per 10 results), matching executeSearch's math.
  searchCredits: number;
  // Flat judge billing: JUDGE_CREDITS_PER_RESULT per result the judge evaluated
  // (covers both the scrape and the judge). Zero in raw mode.
  judgeCredits: number;
  // Denominator for judgeCredits; carried for observability / estimate parity.
  resultsJudged: number;
  pageUpserts: Array<{
    url: string;
    urlHash: Buffer;
    status: string;
    scraped?: boolean;
    metadata: Record<string, unknown>;
    judgment?: {
      meaningful: boolean;
      confidence: "high" | "medium" | "low";
      reason: string;
      meaningfulChanges: [];
    };
  }>;
};

export async function runSearchTarget(params: {
  monitor: {
    id: string;
    teamId: string;
    goal: string | null;
    subject: string;
    // When false, every LLM judge stage is skipped and the target behaves like
    // depth:"raw" (deterministic URLs + dedup, no LLM credits).
    judgeEnabled: boolean;
  };
  target: SearchTargetInput;
  goalVersion: string;
  knownPages: Map<string, KnownPage>;
  knownEvents: KnownEvent[];
  zeroDataRetention: boolean;
  logger: Logger;
}): Promise<SearchTargetRunResult> {
  const { target, knownPages, goalVersion, logger } = params;
  const judgeEnabled = params.monitor.judgeEnabled;

  const goal = params.monitor.goal?.trim();
  // Only the LLM judge requires a goal; raw/judge-off checks still run search.
  if (judgeEnabled && !goal) {
    throw new Error("search monitor target requires a non-empty monitor goal");
  }
  const subject = params.monitor.subject ?? "";
  const teamId = params.monitor.teamId;

  const tbs = windowToTbs(target.searchWindow);
  const events: KnownEvent[] = [...params.knownEvents];
  const satisfied = new Set(events.map(e => e.key));
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;
  // For observability only — billing does not read from it, but the judge
  // helpers require a CostTracking argument.
  const costTracking = new CostTracking();
  // Search calls bill ≈2 credits / 10 results, mirroring executeSearch().
  let searchResultsBilled = 0;
  // Denominator for flat judge billing: judgeCredits = 5 * this.
  let resultsJudged = 0;
  // Deep-path per-result scrape/judge failures (scrape threw, scrape !success,
  // or verdict unparseable) — the silently-swallowed errors that hit `continue`
  // BEFORE resultsJudged is incremented. Counted to mark the check degraded when
  // judging was expected but produced ~nothing DUE TO these failures, so an
  // all-scrapes-failed deep check can't masquerade as a clean "nothing new".
  let judgeScrapeFailures = 0;

  const seenThisRun = new Map<string, number>();
  const candidates: Array<{
    url: string;
    title: string;
    description: string;
    query: string;
    matchedQueries: string[];
  }> = [];
  for (const query of target.queries) {
    const { query: scopedQuery } = buildSearchQuery(query, undefined, {
      includeDomains: target.includeDomains,
      excludeDomains: target.excludeDomains,
    });
    const response = await searchWithRetry(
      {
        query: scopedQuery,
        logger,
        num_results: target.maxResults,
        tbs,
      },
      logger,
    );
    const results = response.web ?? [];
    // Bill on raw results, before dedupe/trim.
    searchResultsBilled += results.length;
    for (const r of results) {
      if (!r.url) continue;
      if (isExcludedDomain(r.url, target.excludeDomains)) continue;
      const canonical = canonicalizeUrl(r.url);
      const existingIdx = seenThisRun.get(canonical);
      if (existingIdx !== undefined) {
        // Same URL from another query this run — record the extra query rather
        // than dropping it.
        const existing = candidates[existingIdx];
        if (!existing.matchedQueries.includes(query)) {
          existing.matchedQueries.push(query);
        }
        continue;
      }
      seenThisRun.set(canonical, candidates.length);
      candidates.push({
        url: r.url,
        title: r.title,
        description: r.description,
        query,
        matchedQueries: [query],
      });
    }
  }
  resultCount = candidates.length;

  const llmStagesAvailable = hasGeminiKey();
  // Judge off → collapse to "raw" so every LLM stage is skipped via the existing
  // raw path, rather than scattering judgeEnabled conditionals.
  const depth: "raw" | "standard" | "deep" = !judgeEnabled
    ? "raw"
    : target.depth === "raw"
      ? "raw"
      : target.depth === "standard" && llmStagesAvailable
        ? "standard"
        : "deep";

  // depth !== "raw" implies judgeEnabled implies a non-empty goal (top guard),
  // so judgeGoal is always populated when judging runs; "" only in raw mode.
  const judgeGoal: string = goal ?? "";

  let criteria: GoalCriteria = compileGoalCriteria({
    goal: judgeGoal,
    subject,
    goalVersion,
  });
  if (llmStagesAvailable && depth !== "raw") {
    try {
      criteria = await compileGoalCriteriaWithLlm({
        goal: judgeGoal,
        subject,
        queries: target.queries,
        goalVersion,
        costTracking,
      });
    } catch (error) {
      logger.warn(
        "search monitor criteria compile failed, keeping deterministic",
        {
          error,
        },
      );
    }
  }

  let selected = candidates.slice(0, target.maxResults);
  if (depth === "deep" && llmStagesAvailable && candidates.length > 0) {
    if (candidates.length > 50) {
      logger.info("search monitor router capped candidates at 50", {
        total: candidates.length,
      });
    }
    try {
      const decisions = await routeSearchResults({
        goal: judgeGoal,
        subject,
        searchWindow: target.searchWindow,
        maxResults: target.maxResults,
        costTracking,
        candidates: candidates.map((c, i) => ({
          id: `result_${i + 1}`,
          query: c.query,
          title: c.title,
          url: c.url,
          snippet: c.description,
        })),
      });
      const byId = new Map<string, RouteDecision>(
        decisions.map(d => [d.id, d]),
      );
      const routed = candidates
        .map((c, i) => ({ c, routing: byId.get(`result_${i + 1}`) }))
        .filter(r => r.routing?.decision === "scrape")
        .sort((a, b) => (b.routing?.priority ?? 0) - (a.routing?.priority ?? 0))
        .map(r => r.c);
      selected = routed.slice(0, target.maxResults);
    } catch (error) {
      logger.warn("search monitor router failed open to top-K", { error });
    }
  }

  const recheckMs = target.recheckAfter ? windowToMs(target.recheckAfter) : 0;
  const pageNeedsJudgment = (c: {
    url: string;
    title: string;
    description: string;
  }) => {
    const canonical = canonicalizeUrl(c.url);
    const known = knownPages.get(canonical);
    const knownCurrent =
      known && known.goalVersion === goalVersion ? known : undefined;
    if (!knownCurrent) return true;
    const fingerprint = stableSerpFingerprint({
      url: c.url,
      title: c.title,
      snippet: c.description,
    });
    if (knownCurrent.fingerprint !== fingerprint) return true;
    const isLive =
      knownCurrent.lastStatus === "alert" ||
      knownCurrent.lastStatus === "watching";
    return Boolean(
      recheckMs &&
        isLive &&
        knownCurrent.lastCheckedAt &&
        Date.now() - Date.parse(knownCurrent.lastCheckedAt) > recheckMs,
    );
  };

  const snippetVerdicts = new Map<string, SearchVerdict>();
  const snippetCandidates = selected.filter(pageNeedsJudgment);
  if (depth === "standard" && snippetCandidates.length > 0) {
    try {
      const verdicts = await judgeSnippets({
        goal: judgeGoal,
        subject,
        searchWindow: target.searchWindow,
        costTracking,
        candidates: snippetCandidates.map((c, i) => ({
          id: `result_${i + 1}`,
          query: c.query,
          title: c.title,
          url: c.url,
          snippet: c.description,
        })),
      });
      const byId = new Map<string, SnippetVerdict>(
        verdicts.map(v => [v.id, v]),
      );
      snippetCandidates.forEach((c, i) => {
        const v = byId.get(`result_${i + 1}`);
        if (v) {
          snippetVerdicts.set(canonicalizeUrl(c.url), {
            relevant: v.relevant,
            alertAction: v.alertAction,
            concept: v.concept,
            rationale: v.rationale,
          });
        }
      });
    } catch (error) {
      logger.warn("search monitor snippet judge failed; results skipped", {
        error,
      });
    }
  }

  for (const c of selected) {
    const canonical = canonicalizeUrl(c.url);
    const fingerprint = stableSerpFingerprint({
      url: c.url,
      title: c.title,
      snippet: c.description,
    });
    const known = knownPages.get(canonical);
    const knownCurrent =
      known && known.goalVersion === goalVersion ? known : undefined;
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

    if (!isNewOrChanged) {
      const reusedStatus: SearchSource["status"] =
        knownCurrent?.lastStatus === "alert" ||
        knownCurrent?.lastStatus === "already_seen"
          ? "already_seen"
          : knownCurrent?.lastStatus === "ignored" ||
              knownCurrent?.lastStatus === "skipped"
            ? knownCurrent.lastStatus
            : "watching";
      sources.push({ url: c.url, title: c.title, status: reusedStatus });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: reusedStatus,
        // Upserts replace metadata wholesale; spread prior metadata to preserve
        // event stamps (eventKey/eventLabel/...) that reconstruction needs.
        // Force judgedThisRun=false: this page is REUSED unchanged, not
        // re-judged, so it must not be counted/billed again even though prior
        // metadata may carry a stale concept/judgedThisRun from when it was
        // first judged.
        metadata: {
          ...(knownCurrent?.metadata ?? {}),
          fingerprint,
          goalVersion,
          searchStatus: reusedStatus,
          judgedThisRun: false,
        },
      });
      continue;
    }

    if (depth === "raw") {
      const nowIso = new Date().toISOString();
      const rawKey = canonical;
      const alreadyAlerted =
        satisfied.has(rawKey) && target.alertMode !== "every_new_result";
      const rawMeta = {
        fingerprint,
        goalVersion,
        searchStatus: alreadyAlerted ? "already_seen" : "alert",
        eventKey: rawKey,
        eventLabel: c.title || canonical,
        query: c.query,
        matchedQueries: c.matchedQueries,
      };
      if (alreadyAlerted) {
        sources.push({
          url: c.url,
          title: c.title,
          status: "already_seen",
          eventKey: rawKey,
        });
        pageUpserts.push({
          url: canonical,
          urlHash: hashMonitorUrl(canonical),
          status: "already_seen",
          scraped: false,
          metadata: rawMeta,
        });
        continue;
      }
      matches += 1;
      satisfied.add(rawKey);
      const existingEvent = events.find(e => e.key === rawKey);
      const eventSatisfiedAt = existingEvent?.satisfiedAt ?? nowIso;
      const eventAlertCount = (existingEvent?.alertCount ?? 0) + 1;
      if (existingEvent) {
        existingEvent.satisfiedAt = eventSatisfiedAt;
        existingEvent.alertCount = eventAlertCount;
      } else {
        events.unshift({
          key: rawKey,
          label: c.title || canonical,
          satisfiedAt: eventSatisfiedAt,
          alertCount: eventAlertCount,
        });
      }
      sources.push({
        url: c.url,
        title: c.title,
        status: "alert",
        eventKey: rawKey,
      });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "alert",
        scraped: false,
        metadata: {
          ...rawMeta,
          eventSatisfiedAt,
          eventAlertCount,
          eventLastAlertAt: nowIso,
        },
        judgment: {
          meaningful: true,
          confidence: "low",
          reason: `New search result for "${c.query}"`,
          meaningfulChanges: [],
        },
      });
      continue;
    }

    let verdict: SearchVerdict | null = null;
    let pageText = "";
    let realDate: string | null = null;
    if (depth === "standard") {
      verdict = snippetVerdicts.get(canonical) ?? null;
      if (!verdict) {
        skipped += 1;
        sources.push({ url: c.url, title: c.title, status: "skipped" });
        continue;
      }
      pagesChecked += 1;
    } else {
      let res;
      const scrapeParsedOptions = scrapeOptions.parse({
        formats: [
          { type: "markdown" },
          {
            type: "json",
            schema: verdictJsonSchema,
            prompt: buildJudgePrompt(judgeGoal, subject, target.searchWindow),
          },
        ],
        timeout: 20000,
      });
      const scrapeCostTracking = new CostTracking();
      try {
        res = await scrapeURL(
          "search-monitor;" + uuidv7(),
          c.url,
          scrapeParsedOptions,
          { teamId, zeroDataRetention: params.zeroDataRetention },
          scrapeCostTracking,
        );
      } catch (error) {
        logger.warn("search monitor scrape threw", { url: c.url, error });
        judgeScrapeFailures += 1;
        skipped += 1;
        sources.push({ url: c.url, title: c.title, status: "skipped" });
        continue;
      }

      if (!res.success) {
        logger.warn("search monitor scrape failed", { url: c.url });
        judgeScrapeFailures += 1;
        skipped += 1;
        sources.push({ url: c.url, title: c.title, status: "skipped" });
        continue;
      }
      pagesChecked += 1;

      verdict = parseVerdict(res.document.json);
      if (!verdict) {
        // Scrape succeeded but the AI verdict was unparseable — the result was
        // fetched yet never actually evaluated, so it counts as a judge-path
        // failure for the degraded signal (not a legitimate "judge ignored it").
        judgeScrapeFailures += 1;
        skipped += 1;
        sources.push({ url: c.url, title: c.title, status: "skipped" });
        continue;
      }
      pageText = res.document.markdown ?? "";
      realDate =
        res.document.metadata?.publishedTime ??
        res.document.metadata?.modifiedTime ??
        null;
    }

    // Canonical "judged result" — the unit of flat billing.
    //
    //   A judged result is a result we scraped (deep) or snippet-judged
    //   (standard) and obtained a parsed AI verdict for THIS run, regardless of
    //   the verdict's outcome (alert/watch/ignore/already_seen). This is exactly
    //   what costs money — the scrape + the verdict LLM call — and exactly what
    //   the docs price: "5 credits per result judged — covers scraping and
    //   evaluating the result".
    //
    // NOT counted (and not billed): the router-skipped subset (never scraped),
    // results whose scrape/verdict failed (status "skipped", no verdict), raw /
    // judge-off results, and unchanged results REUSED from a prior run (those
    // were billed when first judged — see the !isNewOrChanged branch above,
    // which carries a stale `concept` over but must not re-bill). Reaching this
    // line is the single source of truth; every billed page is stamped
    // judgedThisRun=true in baseMeta so the billed count == count of pages with
    // judgedThisRun, with no ambiguity from leaked prior-run concepts.
    resultsJudged += 1;

    let decision = verdictToDecision(verdict);

    let verification: VerificationResult | null = null;
    if (decision === "notify") {
      const evidence: VerifyEvidence = {
        url: c.url,
        titleText: c.title,
        claimText: verdict.rationale,
        pageText,
      };
      const result = verifyAlertCandidate({
        criteria,
        concept: verdict.concept,
        evidence,
      });
      verification = result;
      if (!result.pass) {
        decision = "watch";
        logger.info("search monitor alert downgraded by verifier", {
          url: c.url,
          failures: result.failures,
        });
      }
    }

    if (decision === "notify" && llmStagesAvailable) {
      try {
        const skeptic: SkepticVerdict = await reviewAlert({
          goal: judgeGoal,
          subject,
          criteria,
          costTracking,
          result: {
            title: c.title,
            url: c.url,
            snippet: c.description,
            concept: verdict.concept,
            judgeAnswer: verdict.rationale,
          },
        });
        if (skeptic.refuted) {
          decision = "watch";
          logger.info("search monitor alert refuted by skeptic", {
            url: c.url,
            failureMode: skeptic.failureMode,
            reason: skeptic.reason,
          });
        }
      } catch (error) {
        logger.warn("search monitor skeptic failed open", { error });
      }
    }
    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: verdict.alertAction,
      publishedAt: realDate,
      concept: verdict.concept,
      rationale: verdict.rationale,
      matchedQueries: c.matchedQueries,
      // Stamped iff resultsJudged was incremented just above — the canonical,
      // unambiguous billing signal. `concept` alone is unreliable: the reuse
      // path copies a prior run's concept onto an unchanged page that was NOT
      // re-judged this run. judgedThisRun is true ONLY on results billed now.
      judgedThisRun: true,
      ...(verification && !verification.pass ? { verification } : {}),
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
        scraped: depth === "deep",
        metadata: { ...baseMeta, searchStatus: "ignored" },
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
        scraped: depth === "deep",
        metadata: { ...baseMeta, searchStatus: "watching" },
      });
      continue;
    }

    let resolution;
    try {
      resolution = await resolveEvent({
        goal: judgeGoal,
        subject,
        costTracking,
        result: {
          title: c.title,
          url: c.url,
          evidence: verdict.rationale,
        },
        candidates: events,
      });
    } catch (error) {
      logger.warn("search monitor event resolver failed open to new event", {
        error,
      });
      resolution = {
        matchedKey: null,
        isNew: true,
        label: verdict.concept,
        reason: "resolver_failed",
      };
    }
    const matched =
      resolution.matchedKey &&
      events.find(e => e.key === resolution.matchedKey);
    const eventKey = matched ? matched.key : uuidv7();
    const eventLabel = matched
      ? matched.label
      : resolution.label || verdict.concept;

    let alreadySatisfied = false;
    if (satisfied.has(eventKey)) {
      if (target.alertMode === "first_match") {
        alreadySatisfied = true;
      } else if (target.alertMode === "material_dev") {
        try {
          const dev = await judgeMaterialDevelopment({
            goal: judgeGoal,
            subject,
            eventLabel,
            costTracking,
            result: { title: c.title, evidence: verdict.rationale },
          });
          alreadySatisfied = !dev.material;
        } catch (error) {
          logger.warn("search monitor material judge failed closed", { error });
          alreadySatisfied = true;
        }
      }
    }
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
        scraped: depth === "deep",
        metadata: { ...eventMeta, searchStatus: "already_seen" },
      });
      continue;
    }

    matches += 1;
    satisfied.add(eventKey);
    const nowIso = new Date().toISOString();
    const existingEvent = events.find(e => e.key === eventKey);
    const eventSatisfiedAt = existingEvent?.satisfiedAt ?? nowIso;
    const eventAlertCount = (existingEvent?.alertCount ?? 0) + 1;
    if (existingEvent) {
      existingEvent.satisfiedAt = eventSatisfiedAt;
      existingEvent.alertCount = eventAlertCount;
    } else {
      events.unshift({
        key: eventKey,
        label: eventLabel,
        satisfiedAt: eventSatisfiedAt,
        alertCount: eventAlertCount,
      });
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
      scraped: depth === "deep",
      metadata: {
        ...eventMeta,
        searchStatus: "alert",
        eventSatisfiedAt,
        eventAlertCount,
        eventLastAlertAt: nowIso,
      },
      judgment: {
        meaningful: true,
        confidence: "high",
        reason: verdict.rationale,
        meaningfulChanges: [],
      },
    });
  }

  const meaningful = sources.filter(
    s => s.status === "alert" || s.status === "already_seen",
  ).length;

  let summary = "";
  if (matches > 0 && depth === "raw") {
    summary = `${matches} new search result${matches === 1 ? "" : "s"} matched the monitor queries.`;
  } else if (matches > 0) {
    try {
      const out = await summarizeRun({
        goal: judgeGoal,
        subject,
        costTracking,
        evidence: sources
          .filter(s => s.status === "alert")
          .map(s => ({
            title: s.title,
            url: s.url,
            rationale: s.rationale ?? "",
          })),
      });
      summary = out.summary;
    } catch (error) {
      logger.warn("search monitor summarizer failed; using fallback summary", {
        error,
      });
      summary = `${matches} new result${matches === 1 ? "" : "s"} matched the monitor goal.`;
    }
  }

  // The public search() helper swallows provider errors and returns an empty
  // result, so the monitor can't distinguish a real provider failure from a
  // genuine no-results without reaching into core search. We deliberately don't:
  // empty-after-retries is treated as a clean no-results. The field is kept for
  // the check shape (and the deep-path judge-degraded signal below still fires).
  const searchDegraded = false;

  // Deep-path degraded signal: judging WAS expected (depth deep + search
  // returned candidates) but produced ~nothing (resultsJudged === 0) BECAUSE the
  // per-result scrapes failed (judgeScrapeFailures > 0). This is the conservative
  // trigger — it is deliberately NOT set when:
  //   - search legitimately returned 0 results (judgeExpected is false, no
  //     candidates), or
  //   - the judge legitimately evaluated results and ignored them all
  //     (resultsJudged > 0), or
  //   - only SOME scrapes failed but at least one was judged (resultsJudged > 0).
  // Without this, a deep check whose every scrape timed out completes "clean"
  // with 0 pages / 0 judged / 0 alerts — indistinguishable from "nothing new".
  const judgeExpected = depth === "deep" && candidates.length > 0;
  const judgeDegraded =
    judgeExpected && resultsJudged === 0 && judgeScrapeFailures > 0;
  if (judgeDegraded) {
    logger.warn(
      "search monitor run is degraded: deep-path scrapes failed for every candidate so nothing was judged; results may be incomplete (NOT a clean no-results)",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        candidates: candidates.length,
        scrapeFailures: judgeScrapeFailures,
        resultsJudged,
      },
    );
    if (!summary) {
      summary =
        "Results were found but could not be fetched for evaluation (scrapes failed or timed out); this check is incomplete and may have missed new developments.";
    }
  }

  // Single reason surfaced onto the check when the deep path could not evaluate
  // the results it found.
  const degradedReason: string | null = judgeDegraded
    ? "deep-path scrapes failed for every candidate so nothing was judged; results may be incomplete"
    : null;

  const isZDR = params.zeroDataRetention;
  const searchCredits =
    Math.ceil(searchResultsBilled / 10) * (isZDR ? 10 : 2);
  const judgeCredits = resultsJudged * JUDGE_CREDITS_PER_RESULT;

  return {
    targetId: target.id,
    type: "search",
    resultCount,
    pagesChecked,
    skipped,
    meaningful,
    matches,
    summary,
    searchDegraded,
    judgeDegraded,
    degradedReason,
    sources,
    searchCredits,
    judgeCredits,
    resultsJudged,
    pageUpserts,
  };
}

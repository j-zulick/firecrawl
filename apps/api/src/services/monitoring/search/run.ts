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
// with an error OR a clean HTTP 200 with an empty body — indistinguishable from
// a genuinely-empty result. Retry both empty and failed responses with backoff;
// a real empty query just exhausts attempts and returns empty cleanly. `failed`
// is true only when the LAST attempt was a real failure, so the caller can mark
// the check degraded rather than confidently empty.
const SEARCH_RETRY_BACKOFF_MS = [400, 1200] as const;

async function searchWithRetry(
  args: Parameters<typeof search>[0],
  logger: Logger,
): Promise<{ response: Awaited<ReturnType<typeof search>>; failed: boolean }> {
  const maxAttempts = SEARCH_RETRY_BACKOFF_MS.length + 1;
  let lastResponse: Awaited<ReturnType<typeof search>> = {};
  let lastFailureReason: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let failureReason: string | null = null;
    const response = await search({
      ...args,
      onFailure: reason => {
        failureReason = reason;
      },
    });
    lastResponse = response;
    lastFailureReason = failureReason;

    const hasResults = (response.web?.length ?? 0) > 0;
    if (hasResults) return { response, failed: false };

    const isLastAttempt = attempt === maxAttempts - 1;
    if (!isLastAttempt) {
      const base = SEARCH_RETRY_BACKOFF_MS[attempt];
      const jitter = Math.floor(Math.random() * 250);
      logger.info("search monitor query empty/failed; retrying", {
        query: args.query,
        attempt: attempt + 1,
        failureReason,
        backoffMs: base + jitter,
      });
      await new Promise(r => setTimeout(r, base + jitter));
      continue;
    }
  }

  // Exhausted attempts: a real final failure is the false-negative we must not
  // hide; an empty with no failure is a legitimate no-results.
  if (lastFailureReason) {
    logger.warn(
      "search monitor query failed after retries; reporting degraded (NOT clean no-results)",
      {
        query: args.query,
        reason: lastFailureReason,
        attempts: maxAttempts,
      },
    );
    return { response: lastResponse, failed: true };
  }

  return { response: lastResponse, failed: false };
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
  // True when a query failed at the provider after retries rather than
  // legitimately returning zero results. An empty-but-degraded run means "could
  // not confirm", not a confident "no new results" — avoids a silent false
  // negative on a swallowed rate-limit.
  searchDegraded: boolean;
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
  // Queries that failed at the provider after retries (vs. legitimately empty);
  // used to mark the run degraded.
  let searchFailures = 0;

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
    const { response, failed } = await searchWithRetry(
      {
        query: scopedQuery,
        logger,
        num_results: target.maxResults,
        tbs,
      },
      logger,
    );
    if (failed) {
      searchFailures += 1;
    }
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

      verdict = parseVerdict(res.document.json);
      if (!verdict) {
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

  const searchDegraded = searchFailures > 0;
  if (searchDegraded && matches === 0) {
    // Don't let a swallowed provider failure masquerade as clean no-results.
    logger.warn(
      "search monitor run is degraded: one or more queries failed at the provider after retries; results may be incomplete",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        failedQueries: searchFailures,
        totalQueries: target.queries.length,
      },
    );
    if (!summary) {
      summary =
        "Search provider was unavailable for one or more queries (rate-limited or errored after retries); results may be incomplete.";
    }
  }

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
    sources,
    searchCredits,
    judgeCredits,
    resultsJudged,
    pageUpserts,
  };
}

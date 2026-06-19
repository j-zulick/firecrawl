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

// FLAT judge billing rate: credits charged per result the judge evaluates this
// check (a result that receives an AI verdict — scraped + judged in deep mode).
// Deterministic and known at check time — no token/at-cost math.
export const JUDGE_CREDITS_PER_RESULT = 5;

function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w";
}

// Bounded retry for monitor searches. The upstream provider rate-limits
// near-simultaneous identical queries and can answer with either a thrown/HTTP
// error OR a clean HTTP 200 carrying an empty body — both of which otherwise
// look identical to a genuinely-empty result and silently drop real hits.
//
// Strategy: retry on a hard failure (search() reported it via onFailure) AND on
// an empty result, with exponential backoff + jitter so we don't hammer the
// rate-limiter. A genuinely-empty query simply runs out of attempts and returns
// empty cleanly (no failure flagged), so its correct "no results" behavior is
// preserved. `failed` is only true when the LAST attempt was a real failure,
// letting the caller mark the check degraded instead of confidently empty.
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
    // Success: real results came back. Return immediately.
    if (hasResults) return { response, failed: false };

    // No results. Could be a genuine empty OR a transient rate-limit (error or
    // empty 200). Retry with backoff while attempts remain.
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

  // Exhausted attempts. If the final attempt was a real provider failure,
  // surface it loudly (degraded) — this is the false-negative we must not hide.
  // If it was just empty with no failure, it is a legitimate no-results.
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
  // Full stored monitor_pages metadata, carried through so unchanged-page
  // upserts don't wipe event/verdict fields persisted by earlier runs.
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
  // True when one or more of this target's queries failed at the search
  // provider (rate-limit / HTTP error) after retries, rather than legitimately
  // returning zero results. Callers should treat an empty run with
  // searchDegraded=true as "could not confirm" rather than a confident
  // "no new results", so a swallowed rate-limit isn't a silent false negative.
  searchDegraded: boolean;
  sources: SearchSource[];
  // Credits attributable to the search() calls themselves (≈2 per 10 results),
  // matching executeSearch's search-credit math.
  searchCredits: number;
  // FLAT, deterministic judge billing: JUDGE_CREDITS_PER_RESULT (5) for every
  // result the judge actually evaluated this check — i.e. each result that
  // received an AI verdict (scraped + judged in deep mode). Zero when judging is
  // off (raw mode). Replaces the old at-cost token→credit `llmCredits` and the
  // per-scrape `calculateCreditsToBeBilled` contribution: the flat 5 covers both
  // the scrape and the judge for a search result.
  judgeCredits: number;
  // Number of results that received a judge verdict this check (the denominator
  // for judgeCredits). Carried through for observability / estimate parity.
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
    // Read fresh from the persisted monitor every check. When false, the LLM
    // judge (router, snippet judge, criteria, verify, skeptic, summarizer) is
    // skipped entirely and the target behaves like depth:"raw" — deterministic
    // URLs + dedup state only, with no LLM credits billed. Toggling this via
    // PATCH/UI therefore takes effect on the NEXT check with no redeploy.
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
  // The LLM judge requires a goal; raw/no-LLM mode does not. Only enforce the
  // goal when we'll actually judge, so a judge-off check still runs search and
  // returns raw results even when the monitor has no (or a cleared) goal.
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
  // Shared CostTracking passed to the LLM/judge stages so they can record token
  // usage for observability/debugging. Billing NO LONGER reads from it — judge
  // credits are a flat per-judged-result figure (JUDGE_CREDITS_PER_RESULT),
  // computed deterministically below. The object is kept only because the judge
  // helpers require a CostTracking argument.
  const costTracking = new CostTracking();
  // Search calls bill ≈2 credits / 10 results, mirroring executeSearch().
  let searchResultsBilled = 0;
  // Count of results that received an AI judge verdict this check. This is the
  // single, clear denominator for flat judge billing: judgeCredits = 5 * this.
  let resultsJudged = 0;
  // Count of queries that ultimately FAILED at the provider (rate-limit / HTTP
  // error) after retries, as opposed to legitimately returning zero results.
  // Used to mark the run degraded so an empty check isn't reported as a
  // confident "no changes" when it was really a swallowed search failure.
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
      // A real provider failure (not a genuine empty). Record it so the run is
      // reported as degraded rather than a clean "no changes" for this query.
      searchFailures += 1;
    }
    // v2 search returns { web, news, images }; the monitor consumes web hits.
    const results = response.web ?? [];
    // Bill the search call at the platform rate (executeSearch: ~2 credits / 10
    // results) on the results this query actually returned, before dedupe/trim.
    searchResultsBilled += results.length;
    for (const r of results) {
      if (!r.url) continue;
      if (isExcludedDomain(r.url, target.excludeDomains)) continue;
      const canonical = canonicalizeUrl(r.url);
      const existingIdx = seenThisRun.get(canonical);
      if (existingIdx !== undefined) {
        // Same URL surfaced by another query this run — record the extra query
        // (mirrors the POC's queryHits) instead of dropping it.
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
  // When the judge is disabled, collapse to "raw" so every LLM stage below
  // (router, snippet judge, criteria-with-LLM, verify, skeptic, resolver,
  // material-dev, summarizer) is skipped and no LLM credits are billed —
  // reusing the deterministic raw path instead of scattering judgeEnabled
  // conditionals. depth then drives judging only when judgeEnabled is true.
  const depth: "raw" | "standard" | "deep" = !judgeEnabled
    ? "raw"
    : target.depth === "raw"
      ? "raw"
      : target.depth === "standard" && llmStagesAvailable
        ? "standard"
        : "deep";

  // From here on, any depth !== "raw" path requires a goal. The top-of-function
  // guard guarantees judgeEnabled implies a non-empty goal; depth !== "raw"
  // implies judgeEnabled, so this is always satisfied when judging actually
  // runs; assert it for the type checker (and as a defensive invariant).
  const judgeGoal: string = goal ?? "";

  let criteria: GoalCriteria = compileGoalCriteria({
    // goal can be empty in raw/judge-off mode; criteria is only consumed by
    // the LLM judge stages, which never run when depth === "raw".
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
        // Upserts replace the stored metadata wholesale, so spread the prior
        // metadata to preserve event stamps (eventKey/eventLabel/...) that
        // event reconstruction depends on.
        metadata: {
          ...(knownCurrent?.metadata ?? {}),
          fingerprint,
          goalVersion,
          searchStatus: reusedStatus,
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

    // This result received an AI judge verdict (snippet judge in standard, or
    // scrape+judge in deep). It is the unit of flat judge billing: each such
    // result costs JUDGE_CREDITS_PER_RESULT, regardless of the verdict outcome.
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
    // Don't let a swallowed provider failure masquerade as a clean no-results.
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
  // FLAT, deterministic judge billing: 5 credits per result the judge evaluated
  // this check. No token/at-cost conversion. Zero when judging was off (raw),
  // where resultsJudged stays 0. Known at check time → recorded reliably.
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

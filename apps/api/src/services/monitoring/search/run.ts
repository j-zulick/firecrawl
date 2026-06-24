import type { Logger } from "winston";
import { search } from "../../../search/v2";
import { buildSearchQuery } from "../../../lib/search-query-builder";
import { CostTracking } from "../../../lib/cost-tracking";
import { hashMonitorUrl } from "../store";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import {
  buildJudgePrompt,
  parseVerdict,
  verdictToDecision,
  windowToMs,
  type SearchVerdict,
} from "./judge";
import { judgeSnippets, type KnownEvent, type SnippetVerdict } from "./llm";
import { compileGoalCriteria, type GoalCriteria } from "./criteria";
import {
  verifyAlertCandidate,
  type VerificationResult,
  type VerifyEvidence,
} from "./verify";
import { hasLlmProvider } from "./tuning";
import {
  searchCreditsForResultCount,
  judgeCreditsForJudgedCount,
} from "./billing";

// Shared dedup decision for a search result, used by both the pre-scrape pass and
// the per-result loop so they never disagree on which results to scrape/judge.
function evaluateSerpCandidate(
  c: { url: string; title: string; description: string },
  knownPages: Map<string, KnownPage>,
  goalVersion: string,
  recheckMs: number | undefined,
): {
  canonical: string;
  fingerprint: string;
  knownCurrent: KnownPage | undefined;
  isNewOrChanged: boolean;
} {
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
    !knownCurrent || knownCurrent.fingerprint !== fingerprint || dueForRecheck;
  return { canonical, fingerprint, knownCurrent, isNewOrChanged };
}

function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w";
}

// Retry an empty result with growing backoff — the backend sometimes returns 0 for
// a query that succeeds moments later.
const SEARCH_RETRY_BACKOFF_MS = [400, 1200, 3000, 6000] as const;

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
  metadata?: Record<string, unknown>;
};

// Deep-mode page scrape. Injected by the caller so it can route through the
// shared monitor scrape path (concurrency queue + bypassBilling), keeping this
// module free of worker/queue dependencies. Resolves to null on scrape failure.
export type ScrapeSearchResult = {
  json: unknown;
  markdown: string;
  metadata: { publishedTime?: string | null; modifiedTime?: string | null };
};

type ScrapeSearchPage = (args: {
  url: string;
  judgePrompt: string;
}) => Promise<ScrapeSearchResult | null>;

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
  judgeDegraded: boolean;
  degradedReason: string | null;
  sources: SearchSource[];
  searchCredits: number;
  judgeCredits: number;
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
    judgeEnabled: boolean;
  };
  target: SearchTargetInput;
  monitorCheckId: string;
  scrapePage: ScrapeSearchPage;
  goalVersion: string;
  knownPages: Map<string, KnownPage>;
  knownEvents: KnownEvent[];
  zeroDataRetention: boolean;
  logger: Logger;
}): Promise<SearchTargetRunResult> {
  const { target, knownPages, goalVersion, logger } = params;
  const judgeEnabled = params.monitor.judgeEnabled;

  const goal = params.monitor.goal?.trim();
  if (judgeEnabled && !goal) {
    throw new Error("search monitor target requires a non-empty monitor goal");
  }
  const subject = params.monitor.subject ?? "";
  const teamId = params.monitor.teamId;
  // Vertex billing labels attached to every LLM call for usage tracing.
  const labels = {
    teamId,
    monitorId: params.monitor.id,
    monitorCheckId: params.monitorCheckId,
  };

  const tbs = windowToTbs(target.searchWindow);
  const events: KnownEvent[] = [...params.knownEvents];
  const satisfied = new Set(events.map(e => e.key));
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;
  const costTracking = new CostTracking();
  let searchResultsBilled = 0;
  let resultsJudged = 0;
  let judgeScrapeFailures = 0;
  let snippetJudgeFailed = false;

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
    searchResultsBilled += results.length;
    for (const r of results) {
      if (!r.url) continue;
      if (isExcludedDomain(r.url, target.excludeDomains)) continue;
      const canonical = canonicalizeUrl(r.url);
      const existingIdx = seenThisRun.get(canonical);
      if (existingIdx !== undefined) {
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

  // An empty retrieval is indistinguishable from "nothing matched", so log it to
  // make a genuine miss diagnosable.
  if (resultCount === 0) {
    logger.warn(
      "search monitor: all queries returned no results after retries",
      {
        queries: target.queries,
        searchWindow: target.searchWindow,
        includeDomains: target.includeDomains,
      },
    );
  }

  const llmStagesAvailable = hasLlmProvider();
  const depth: "raw" | "standard" | "deep" = !judgeEnabled
    ? "raw"
    : target.depth === "raw"
      ? "raw"
      : target.depth === "standard" && llmStagesAvailable
        ? "standard"
        : "deep";

  const judgeGoal: string = goal ?? "";

  // Deterministic criteria for the (non-LLM) verifier — no LLM enrich/router.
  const criteria: GoalCriteria = compileGoalCriteria({
    goal: judgeGoal,
    subject,
    goalVersion,
  });

  const selected = candidates.slice(0, target.maxResults);

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
        labels,
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
      snippetJudgeFailed = true;
      logger.warn("search monitor snippet judge failed; results skipped", {
        error,
      });
    }
  }

  // Pre-scrape deep-mode pages concurrently and cache them, so the loop below isn't
  // a serial scrape→judge→scrape chain. Only the I/O is parallel; all dedup/event
  // state stays in the single-threaded loop. (NuQ bounds the actual scrape fan-out.)
  const deepDocs = new Map<
    string,
    { doc: ScrapeSearchResult | null; error?: unknown }
  >();
  if (depth === "deep" && llmStagesAvailable) {
    const judgePrompt = buildJudgePrompt(
      judgeGoal,
      subject,
      target.searchWindow,
    );
    await Promise.all(
      selected
        .filter(
          c =>
            evaluateSerpCandidate(c, knownPages, goalVersion, recheckMs)
              .isNewOrChanged,
        )
        .map(async c => {
          const canonical = canonicalizeUrl(c.url);
          try {
            deepDocs.set(canonical, {
              doc: await params.scrapePage({ url: c.url, judgePrompt }),
            });
          } catch (error) {
            deepDocs.set(canonical, { doc: null, error });
          }
        }),
    );
  }

  for (const c of selected) {
    const { canonical, fingerprint, knownCurrent, isNewOrChanged } =
      evaluateSerpCandidate(c, knownPages, goalVersion, recheckMs);
    const pushUnevaluatedPage = (error: string) => {
      skipped += 1;
      sources.push({ url: c.url, title: c.title, status: "skipped" });
      pageUpserts.push({
        url: canonical,
        urlHash: hashMonitorUrl(canonical),
        status: "skipped",
        scraped: false,
        metadata: {
          fingerprint,
          goalVersion,
          searchStatus: "skipped",
          matchedQueries: c.matchedQueries,
          judgedThisRun: false,
          error,
        },
      });
    };

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
        // Raw mode does not run the judge, so it carries no judgment — these are
        // surfaced as new results, not evaluated as "meaningful".
      });
      continue;
    }

    let verdict: SearchVerdict | null = null;
    let pageText = "";
    let realDate: string | null = null;
    if (depth === "standard") {
      verdict = snippetVerdicts.get(canonical) ?? null;
      if (!verdict) {
        if (snippetJudgeFailed) {
          pushUnevaluatedPage("snippet judge failed");
        } else {
          skipped += 1;
          sources.push({ url: c.url, title: c.title, status: "skipped" });
        }
        continue;
      }
      pagesChecked += 1;
    } else {
      // Read the doc from the pre-scrape cache; scrape inline only as a fallback.
      let doc: ScrapeSearchResult | null;
      const cached = deepDocs.get(canonical);
      if (cached?.error !== undefined) {
        logger.warn("search monitor scrape threw", {
          url: c.url,
          error: cached.error,
        });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage(
          cached.error instanceof Error ? cached.error.message : "scrape threw",
        );
        continue;
      }
      try {
        doc = cached
          ? cached.doc
          : await params.scrapePage({
              url: c.url,
              judgePrompt: buildJudgePrompt(
                judgeGoal,
                subject,
                target.searchWindow,
              ),
            });
      } catch (error) {
        logger.warn("search monitor scrape threw", { url: c.url, error });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage(
          error instanceof Error ? error.message : "scrape threw",
        );
        continue;
      }

      if (!doc) {
        logger.warn("search monitor scrape failed", { url: c.url });
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("scrape failed");
        continue;
      }
      pagesChecked += 1;

      verdict = parseVerdict(doc.json);
      if (!verdict) {
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("verdict unparseable");
        continue;
      }
      pageText = doc.markdown ?? "";
      realDate =
        doc.metadata?.publishedTime ?? doc.metadata?.modifiedTime ?? null;
    }

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

    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: verdict.alertAction,
      publishedAt: realDate,
      concept: verdict.concept,
      rationale: verdict.rationale,
      matchedQueries: c.matchedQueries,
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

    // Deterministic event key: dedup by canonical URL (no LLM event resolver).
    const eventKey = canonical;
    const eventLabel = verdict.concept || canonical;

    // Re-alert on every new result only in every_new_result mode; otherwise the
    // canonical URL is deduped so we don't re-alert the same page.
    const alreadySatisfied =
      satisfied.has(eventKey) && target.alertMode !== "every_new_result";
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

  let summary =
    matches > 0
      ? `${matches} match${matches === 1 ? "" : "es"} across ${resultCount} result${resultCount === 1 ? "" : "s"}.`
      : "";

  const deepJudgeFailed =
    depth === "deep" &&
    candidates.length > 0 &&
    resultsJudged === 0 &&
    judgeScrapeFailures > 0;
  const standardJudgeFailed =
    depth === "standard" && resultsJudged === 0 && snippetJudgeFailed;
  const judgeDegraded = deepJudgeFailed || standardJudgeFailed;
  if (judgeDegraded) {
    logger.warn(
      "search monitor run is degraded: results were found but none could be judged; results may be incomplete (NOT a clean no-results)",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        depth,
        candidates: candidates.length,
        scrapeFailures: judgeScrapeFailures,
        snippetJudgeFailed,
        resultsJudged,
      },
    );
    if (!summary) {
      summary =
        "Results were found but could not be evaluated (the judge step failed); this check is incomplete and may have missed new developments.";
    }
  }

  const degradedReason: string | null = judgeDegraded
    ? "results were found but none could be judged; results may be incomplete"
    : null;

  const isZDR = params.zeroDataRetention;
  const searchCredits = searchCreditsForResultCount(searchResultsBilled, isZDR);
  const judgeCredits = judgeCreditsForJudgedCount(resultsJudged);

  return {
    targetId: target.id,
    type: "search",
    resultCount,
    pagesChecked,
    skipped,
    meaningful,
    matches,
    summary,
    judgeDegraded,
    degradedReason,
    sources,
    searchCredits,
    judgeCredits,
    resultsJudged,
    pageUpserts,
  };
}

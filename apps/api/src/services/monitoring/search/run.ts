import type { Logger } from "winston";
import { search } from "../../../search/v2";
import { buildSearchQuery } from "../../../lib/search-query-builder";
import { hashMonitorUrl } from "../store";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";
import {
  buildJudgePrompt,
  parseVerdict,
  verdictToDecision,
  windowToMs,
  type SearchVerdict,
} from "./judge";
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

// A successful-but-empty SERP almost always means a genuine "no results" for this
// query+window — NOT a transient failure. The backend can occasionally return 0 for
// a query that succeeds a moment later, so hedge with a couple of QUICK retries, but
// don't burn ~11s of growing backoff (the old [400,1200,3000,6000]) on a query that
// simply has no matches — that latency stacks across queries and slows every check
// whose results legitimately don't exist.
const SEARCH_EMPTY_RETRY_BACKOFF_MS = [500, 1000] as const;

// Hard wall-clock budget for a single inline search run. The deep-mode page
// scrapes are the only unbounded-ish step (each is capped at 20s, but a large
// candidate set could still add up); if the concurrent pre-scrape blows past
// this, we stop waiting and let the remaining candidates fall through as
// skipped/degraded rather than holding the consumer. Kept well under the
// 10-minute search stale timeout so a run always returns before the reaper.
const SEARCH_RUN_BUDGET_MS = 4 * 60 * 1000;

// Deep-mode page scrapes run INLINE in the worker process (skipNuq), so they are
// NOT bounded by NuQ's per-team/global concurrency. Cap the pre-scrape fan-out
// ourselves so a single maxResults=50 check can't launch 50 simultaneous
// fetch+LLM-extraction scrapes and starve the worker that owns the search consumer.
const SEARCH_SCRAPE_CONCURRENCY = 6;

// Run fn over items with at most `limit` in flight at once. Never rejects per the
// caller's needs — fn is expected to swallow its own errors (it writes outcomes
// into a shared cache).
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(pool);
}

// Race a promise against a wall-clock deadline. Resolves false if the work
// finishes first, true if the deadline hits. Never rejects; the underlying work
// keeps running (bounded by its own per-scrape timeout) and populates its cache.
async function raceDeadline(
  work: Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    work.then(() => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), Math.max(0, budgetMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return timedOut;
}

async function searchWithRetry(
  args: Parameters<typeof search>[0],
  logger: Logger,
): Promise<Awaited<ReturnType<typeof search>>> {
  const maxAttempts = SEARCH_EMPTY_RETRY_BACKOFF_MS.length + 1;
  let lastResponse: Awaited<ReturnType<typeof search>> = {};

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await search(args);
    lastResponse = response;

    const hasResults = (response.web?.length ?? 0) > 0;
    if (hasResults) return response;

    const isLastAttempt = attempt === maxAttempts - 1;
    if (!isLastAttempt) {
      const base = SEARCH_EMPTY_RETRY_BACKOFF_MS[attempt];
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

export type KnownEvent = {
  key: string;
  label: string;
  satisfiedAt?: string;
  alertCount?: number;
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
  // Per-page scrape failures in deep mode. partialScrapeLoss is a SOFT signal
  // (distinct from judgeDegraded): some results judged, but a majority of the
  // attempted scrapes failed — the run is usable but likely missed developments.
  scrapeFailures: number;
  partialScrapeLoss: boolean;
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
  const runStart = Date.now();

  const goal = params.monitor.goal?.trim();
  if (judgeEnabled && !goal) {
    throw new Error("search monitor target requires a non-empty monitor goal");
  }
  const subject = params.monitor.subject ?? "";

  const tbs = windowToTbs(target.searchWindow);
  const events: KnownEvent[] = [...params.knownEvents];
  const satisfied = new Set(events.map(e => e.key));
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;
  let searchResultsBilled = 0;
  let resultsJudged = 0;
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
  // Judge depth is raw (no LLM) or deep (per-page scrape + verdict). Standard
  // (snippet-only judging) was removed: it was unreachable via the API (depth is
  // stripped) and used a divergent LLM provider; deep is the single judged path.
  const depth: "raw" | "deep" =
    !judgeEnabled || target.depth === "raw" ? "raw" : "deep";

  const judgeGoal: string = goal ?? "";

  const selected = candidates.slice(0, target.maxResults);

  const recheckMs = target.recheckAfter ? windowToMs(target.recheckAfter) : 0;

  // Pre-scrape deep-mode pages (bounded concurrency) and cache them, so the loop
  // below isn't a serial scrape→judge→scrape chain. Only the I/O is parallel; all
  // dedup/event state stays in the single-threaded loop. These scrapes run inline
  // (skipNuq), so the fan-out is bounded by SEARCH_SCRAPE_CONCURRENCY, not NuQ.
  const deepDocs = new Map<
    string,
    { doc: ScrapeSearchResult | null; error?: unknown }
  >();
  // Set if the concurrent pre-scrape exceeds the run budget: any candidate not
  // yet cached is then treated as a scrape failure instead of being inline-scraped,
  // so the loop returns promptly rather than holding the consumer.
  let budgetExceeded = false;
  if (depth === "deep" && llmStagesAvailable) {
    const judgePrompt = buildJudgePrompt(
      judgeGoal,
      subject,
      target.searchWindow,
    );
    const toScrape = selected.filter(
      c =>
        evaluateSerpCandidate(c, knownPages, goalVersion, recheckMs)
          .isNewOrChanged,
    );
    const preScrape = mapWithConcurrency(
      toScrape,
      SEARCH_SCRAPE_CONCURRENCY,
      async c => {
        const canonical = canonicalizeUrl(c.url);
        try {
          deepDocs.set(canonical, {
            doc: await params.scrapePage({ url: c.url, judgePrompt }),
          });
        } catch (error) {
          deepDocs.set(canonical, { doc: null, error });
        }
      },
    );
    const remainingBudget = SEARCH_RUN_BUDGET_MS - (Date.now() - runStart);
    budgetExceeded = await raceDeadline(preScrape, remainingBudget);
    if (budgetExceeded) {
      logger.warn(
        "search monitor run exceeded its time budget; finishing with partial scrapes",
        {
          monitorId: params.monitor.id,
          targetId: target.id,
          budgetMs: SEARCH_RUN_BUDGET_MS,
          scraped: deepDocs.size,
        },
      );
    }
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
    let realDate: string | null = null;
    {
      // Deep mode: read the doc from the pre-scrape cache; scrape inline only as a fallback.
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
      // The pre-scrape ran out of time before caching this page. Treat it as a
      // scrape failure rather than inline-scraping (which would re-incur the time
      // we just budgeted out of), so the run returns promptly.
      if (!cached && budgetExceeded) {
        judgeScrapeFailures += 1;
        pushUnevaluatedPage("run budget exceeded before scrape");
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
      realDate =
        doc.metadata?.publishedTime ?? doc.metadata?.modifiedTime ?? null;
    }

    resultsJudged += 1;

    const decision = verdictToDecision(verdict);

    const baseMeta = {
      fingerprint,
      goalVersion,
      alertAction: verdict.alertAction,
      publishedAt: realDate,
      concept: verdict.concept,
      rationale: verdict.rationale,
      matchedQueries: c.matchedQueries,
      judgedThisRun: true,
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

  const judgeDegraded =
    depth === "deep" &&
    candidates.length > 0 &&
    resultsJudged === 0 &&
    judgeScrapeFailures > 0;
  if (judgeDegraded) {
    logger.warn(
      "search monitor run is degraded: results were found but none could be judged; results may be incomplete (NOT a clean no-results)",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        depth,
        candidates: candidates.length,
        scrapeFailures: judgeScrapeFailures,
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

  // Soft signal (NOT judgeDegraded): the run produced verdicts, but a majority of
  // the attempted deep scrapes failed, so it likely missed real developments.
  // Surfaced for observability; does not fail the check.
  const partialScrapeLoss =
    resultsJudged > 0 &&
    judgeScrapeFailures > 0 &&
    judgeScrapeFailures / (resultsJudged + judgeScrapeFailures) >= 0.5;
  if (partialScrapeLoss) {
    logger.warn(
      "search monitor run had heavy partial scrape loss: judged some results but most scrapes failed; coverage may be incomplete",
      {
        monitorId: params.monitor.id,
        targetId: target.id,
        resultsJudged,
        scrapeFailures: judgeScrapeFailures,
      },
    );
  }

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
    scrapeFailures: judgeScrapeFailures,
    partialScrapeLoss,
    sources,
    searchCredits,
    judgeCredits,
    resultsJudged,
    pageUpserts,
  };
}

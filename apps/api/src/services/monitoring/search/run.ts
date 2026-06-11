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

function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w";
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
  depth?: "standard" | "deep";
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
  sources: SearchSource[];
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
  const satisfied = new Set(events.map(e => e.key));
  const sources: SearchSource[] = [];
  const pageUpserts: SearchTargetRunResult["pageUpserts"] = [];
  let resultCount = 0;
  let pagesChecked = 0;
  let skipped = 0;
  let matches = 0;

  const seenThisRun = new Set<string>();
  const candidates: Array<{
    url: string;
    title: string;
    description: string;
    query: string;
  }> = [];
  for (const query of target.queries) {
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
      if (isExcludedDomain(r.url, target.excludeDomains)) continue;
      const canonical = canonicalizeUrl(r.url);
      if (seenThisRun.has(canonical)) continue;
      seenThisRun.add(canonical);
      candidates.push({
        url: r.url,
        title: r.title,
        description: r.description,
        query,
      });
    }
  }
  resultCount = candidates.length;

  const llmStagesAvailable = hasGeminiKey();
  const depth: "standard" | "deep" =
    target.depth === "standard" && llmStagesAvailable ? "standard" : "deep";

  let criteria: GoalCriteria = compileGoalCriteria({
    goal,
    subject,
    goalVersion,
  });
  if (llmStagesAvailable) {
    try {
      criteria = await compileGoalCriteriaWithLlm({
        goal,
        subject,
        queries: target.queries,
        goalVersion,
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
        goal,
        subject,
        searchWindow: target.searchWindow,
        maxResults: target.maxResults,
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
        goal,
        subject,
        searchWindow: target.searchWindow,
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
        metadata: { fingerprint, goalVersion },
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
      try {
        res = await scrapeURL(
          "search-monitor;" + uuidv7(),
          c.url,
          scrapeOptions.parse({
            formats: [
              { type: "markdown" },
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
          goal,
          subject,
          criteria,
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

    let resolution;
    try {
      resolution = await resolveEvent({
        goal,
        subject,
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
            goal,
            subject,
            eventLabel,
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
        metadata: eventMeta,
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
  if (matches > 0) {
    try {
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
    } catch (error) {
      logger.warn("search monitor summarizer failed; using fallback summary", {
        error,
      });
      summary = `${matches} new result${matches === 1 ? "" : "s"} matched the monitor goal.`;
    }
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

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
  applyVerdictDefenses,
  buildJudgePrompt,
  freshnessFromDate,
  parseVerdict,
  stripJudgeMetaClaims,
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

// Unified schedule/window step → Firecrawl tbs window.
function windowToTbs(window: string): string {
  if (window === "5m" || window === "15m" || window === "1h") return "qdr:h";
  if (window === "6h" || window === "24h") return "qdr:d";
  return "qdr:w"; // 7d
}

// Exclude wins over include (Exa/Parallel semantics). The -site: operators in
// the scoped query are advisory — not every search provider honors them — so
// the blocklist is also enforced here on the returned results.
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
  // Re-judge a still-live result (last status alert/watching) when its last check is older than
  // this window, even if the SERP snippet is unchanged — catches content updates SERP text misses.
  recheckAfter?: string;
  maxResults: number;
  // "deep" (default) scrapes + judges routed pages; "standard" judges from SERP
  // snippets in one batched call — no page fetches, the cheap tier. Standard
  // requires a Gemini key; without one it falls back to deep behavior.
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
  const candidates: Array<{
    url: string;
    title: string;
    description: string;
    query: string;
  }> = [];
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

  // Criteria artifact for the verifier + skeptic. Deterministic compile is
  // free and always available; the LLM enrichment (aliases, competitors, owned
  // hosts) fails safe back to deterministic. Compiled per run — cheap on a
  // thinking-suppressed flash-class model; persistence keyed to goalVersion is
  // a follow-up optimization, not a correctness need.
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

  // Route which candidates are worth scrape/judge spend (deep mode). The LLM
  // router fails open to deterministic top-K — the pre-port behavior.
  let selected = candidates.slice(0, target.maxResults);
  if (depth === "deep" && llmStagesAvailable && candidates.length > 0) {
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

  // Standard depth: one batched snippet-judge call for the whole selection —
  // no page fetches. Verdicts keyed by canonical URL for the loop below.
  const snippetVerdicts = new Map<string, SearchVerdict>();
  if (depth === "standard" && selected.length > 0) {
    try {
      const verdicts = await judgeSnippets({
        goal,
        subject,
        searchWindow: target.searchWindow,
        candidates: selected.map((c, i) => ({
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
      selected.forEach((c, i) => {
        const v = byId.get(`result_${i + 1}`);
        if (v) {
          snippetVerdicts.set(canonicalizeUrl(c.url), {
            relevant: v.relevant,
            alertAction: v.alertAction,
            freshness: v.freshness,
            sourceQuality: v.sourceQuality,
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

  // 2. Per candidate: dedup → (judge if new/changed) → decide → event-resolve.
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

    // Known + unchanged under the current goal → reuse, no scrape/judge/LLM. The reused
    // status carries the page's prior outcome forward: "already_seen" must mean "this
    // alerted before" — a page that only ever watched/ignored repeats as such, otherwise
    // the UI reports a prior alert that never happened (and flipping it to already_seen
    // would also drop it out of the isLive recheck cadence above).
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

    // Judge: deep scrapes the page (verdict returns on document.json, markdown
    // kept for the verifier); standard reads the batched snippet verdict.
    let verdict: SearchVerdict | null = null;
    let pageText = "";
    let pageMetadata: Record<string, unknown> | null = null;
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
      pageMetadata = (res.document.metadata ?? null) as Record<
        string,
        unknown
      > | null;
      realDate =
        res.document.metadata?.publishedTime ??
        res.document.metadata?.modifiedTime ??
        null;
    }

    // Mechanical defense: a verdict whose rationale negates its own booleans is
    // corrected before anything downstream consumes it.
    verdict = applyVerdictDefenses(verdict);

    // Prefer a real publish date over the LLM's freshness guess (freshness is an alert veto).
    const dateFreshness = freshnessFromDate(
      realDate,
      target.searchWindow,
      Date.now(),
    );
    const effectiveVerdict = dateFreshness
      ? { ...verdict, freshness: dateFreshness }
      : verdict;
    // Downstream stages (verifier, skeptic, resolver) must see page facts, not
    // the judge grading itself.
    const strippedRationale = stripJudgeMetaClaims(effectiveVerdict.rationale);

    let decision = verdictToDecision(effectiveVerdict);

    // Alert boundary, stage 1 — deterministic verification against the compiled
    // criteria. Downgrade-only (notify → watch), fail-open on unknown shapes.
    let verification: VerificationResult | null = null;
    if (decision === "notify") {
      const evidence: VerifyEvidence = {
        url: c.url,
        titleText: c.title,
        claimText: strippedRationale,
        pageText,
        metadata: pageMetadata,
      };
      const result = verifyAlertCandidate({
        criteria,
        concept: effectiveVerdict.concept,
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

    // Alert boundary, stage 2 — adversarial skeptic. Runs only on surviving
    // notify candidates (cost bounded by the alert rate); fails OPEN so a
    // skeptic outage can't silently drop real alerts.
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
            concept: effectiveVerdict.concept,
            judgeAnswer: strippedRationale,
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
      alertAction: effectiveVerdict.alertAction,
      freshness: effectiveVerdict.freshness,
      freshnessSource: dateFreshness ? "date" : "llm",
      publishedAt: realDate,
      sourceQuality: effectiveVerdict.sourceQuality,
      concept: effectiveVerdict.concept,
      rationale: effectiveVerdict.rationale,
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

    // notify → resolve the real-world event against the known events (small list, handed straight
    // to the LLM). Matches reuse the existing stable key; new events mint one. Resolver failure
    // fails open to a new event: a possible duplicate alert beats a silently dropped one.
    let resolution;
    try {
      resolution = await resolveEvent({
        goal,
        subject,
        result: {
          title: c.title,
          url: c.url,
          evidence: strippedRationale,
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
        label: effectiveVerdict.concept,
        reason: "resolver_failed",
      };
    }
    const matched =
      resolution.matchedKey &&
      events.find(e => e.key === resolution.matchedKey);
    // New event → mint a stable, content-independent key so a future relabel can't drift it.
    const eventKey = matched ? matched.key : uuidv7();
    const eventLabel = matched
      ? matched.label
      : resolution.label || effectiveVerdict.concept;

    // Suppression by mode. first_match: alert once per event. material_dev: alert once, then
    // re-alert only when a later result adds materially-new info to the known event.
    // every_new_result: never event-suppressed (alerts each new URL).
    let alreadySatisfied = false;
    if (satisfied.has(eventKey)) {
      if (target.alertMode === "first_match") {
        alreadySatisfied = true;
      } else if (target.alertMode === "material_dev") {
        // Fails CLOSED: an unjudgeable "material development" stays suppressed —
        // re-alerting an already-alerted event on an LLM outage is the worse error.
        try {
          const dev = await judgeMaterialDevelopment({
            goal,
            subject,
            eventLabel,
            result: { title: c.title, evidence: strippedRationale },
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

    // New, meaningful, not-yet-satisfied → alert.
    matches += 1;
    satisfied.add(eventKey);
    if (!events.some(e => e.key === eventKey)) {
      // Newest first: the resolver only sees the first ~20 candidates, and an
      // event minted earlier in this same run must be visible to later results.
      events.unshift({ key: eventKey, label: eventLabel });
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
    // Summarizer failure must not fail the run — fall back to a counting summary.
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

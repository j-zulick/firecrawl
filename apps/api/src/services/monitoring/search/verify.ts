import { containsAlias, tokenizeContent, type GoalCriteria } from "./criteria";

// Deterministic verification of a judge "alert" verdict. Every check is a
// universal mechanic (string containment, set membership, token overlap, page
// shape measurement) — goal-specific knowledge comes exclusively from the
// compiled criteria, and a check whose criteria field is empty is a no-op, so
// unknown goal shapes degrade to trusting the judge rather than breaking.
//
// Verification gates (alert → watch); it never escalates and never ignores.
// Ported from the POC's alert-verifier.js.

const LISTING_PAGE_TYPES = new Set([
  "collectionpage",
  "itemlist",
  "searchresultspage",
  "profilepage",
]);

const ARTICLE_PAGE_TYPES = new Set([
  "article",
  "newsarticle",
  "blogposting",
  "report",
  "pressrelease",
  "techarticle",
  "scholarlyarticle",
]);

export type VerifyEvidence = {
  url: string;
  titleText: string;
  // The judge's claim about the page (rationale), already meta-claim-stripped.
  claimText: string;
  // Scraped page markdown when available; empty for snippet-only results.
  pageText: string;
  metadata?: Record<string, unknown> | null;
};

type VerificationFailure = { check: string; detail: string };

export type VerificationResult = {
  pass: boolean;
  failures: VerificationFailure[];
  criteriaSource: GoalCriteria["generatedBy"];
};

export function verifyAlertCandidate(params: {
  criteria: GoalCriteria;
  evidence: VerifyEvidence;
  concept: string;
}): VerificationResult {
  const { criteria, evidence } = params;
  const failures: VerificationFailure[] = [];

  const pageBackedText = [evidence.titleText, evidence.claimText]
    .filter(Boolean)
    .join(" ");
  const conceptText = String(params.concept ?? "");
  const hasPageContent = Boolean(String(evidence.pageText ?? "").trim());

  // 1. Subject containment — the monitored entity must actually appear in the
  //    visible evidence, not just in the query we sent. Only enforceable when
  //    we hold the page content the judge read: on snippet-only results the
  //    judge saw more than we did, so absence here proves nothing.
  if (
    criteria.subjectAliases.length > 0 &&
    hasPageContent &&
    pageBackedText.trim()
  ) {
    // Whole-alias containment, or any single alias token: an inferred subject
    // can be a multi-word phrase ("Anthropic models") whose exact phrasing
    // never appears even though the entity plainly does.
    const present = criteria.subjectAliases.some(
      alias =>
        containsAlias(pageBackedText, alias) ||
        tokenizeContent(alias).some(token =>
          containsAlias(pageBackedText, token),
        ),
    );
    if (!present) {
      failures.push({
        check: "subject_missing",
        detail: `none of [${criteria.subjectAliases.join(", ")}] appear in the page evidence`,
      });
    }
  }

  // 2. Excluded-subject dominance — the story is ABOUT an entity the goal
  //    excludes (e.g. a competitor) and the alert concept doesn't name the
  //    subject. Name-drops of the subject inside someone else's story.
  if (criteria.excludedSubjects.length > 0 && conceptText) {
    const conceptNamesAlias = criteria.subjectAliases.some(alias =>
      containsAlias(conceptText, alias),
    );
    const excludedInConcept = criteria.excludedSubjects.find(
      excluded =>
        containsAlias(conceptText, excluded) ||
        containsAlias(evidence.titleText, excluded),
    );
    if (excludedInConcept && !conceptNamesAlias) {
      failures.push({
        check: "excluded_subject",
        detail: `the story is about "${excludedInConcept}", which this monitor excludes`,
      });
    }
  }

  // 3. Concept relevance — the alert's event/topic label must share at least
  //    one content token with what the goal is about. Exact token comparison
  //    only: inflection variants ("lawsuit"/"lawsuits") are the compiler's job
  //    to enumerate into mustConcern as data, never code's job to derive.
  // Enforced only with LLM-compiled criteria: the deterministic compile's
  // token list is known-incomplete, and an incomplete allowlist must not veto.
  if (
    criteria.generatedBy === "llm" &&
    criteria.mustConcern.length > 0 &&
    conceptText
  ) {
    const conceptTokens = new Set(tokenizeContent(conceptText));
    const aliasTokens = criteria.subjectAliases.flatMap(tokenizeContent);
    const relevant = [...criteria.mustConcern, ...aliasTokens].some(token =>
      conceptTokens.has(token),
    );
    if (conceptTokens.size > 0 && !relevant) {
      failures.push({
        check: "concept_off_goal",
        detail: `alert concept "${conceptText.slice(0, 80)}" shares no content terms with the goal`,
      });
    }
  }

  // 4. Page shape — listing/aggregator/hub pages are surfaces, not stories.
  //    Structured metadata wins when present; otherwise measure link density on
  //    the scraped markdown (counting, not pattern matching). Skipped entirely
  //    for snippet-only results.
  const shape = classifyPageShape(evidence);
  if (shape.kind === "listing") {
    failures.push({ check: "listing_surface", detail: shape.detail });
  }

  // 5. Owned surface — only when the goal explicitly wants third-party
  //    coverage. For event goals (releases, filings) the subject's own site is
  //    the most authoritative source there is, never a disqualified one.
  if (criteria.thirdPartyOnly === true && criteria.ownedHosts.length > 0) {
    const host = hostOf(evidence.url);
    const owned =
      host &&
      criteria.ownedHosts.find(
        ownedHost => host === ownedHost || host.endsWith(`.${ownedHost}`),
      );
    if (owned) {
      failures.push({
        check: "owned_surface",
        detail: `${host} is operated by the monitored subject`,
      });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    criteriaSource: criteria.generatedBy,
  };
}

export function classifyPageShape(evidence: VerifyEvidence): {
  kind: "article" | "listing" | "unknown";
  detail: string;
} {
  const declared = declaredPageTypes(evidence.metadata);
  if (declared.some(type => ARTICLE_PAGE_TYPES.has(type))) {
    return { kind: "article", detail: `declared ${declared.join("/")}` };
  }
  if (declared.some(type => LISTING_PAGE_TYPES.has(type))) {
    return {
      kind: "listing",
      detail: `page declares itself ${declared.join("/")}`,
    };
  }

  const pageText = String(evidence.pageText ?? "");
  if (!pageText.trim()) {
    return { kind: "unknown", detail: "no page content to measure" };
  }

  const words = pageText.split(/\s+/).filter(Boolean).length;
  const links = countLinks(pageText);
  const publishedAt = publishedDate(evidence.metadata);
  const density = words > 0 ? links / words : 0;

  // A real article is prose; an aggregator/directory is a wall of links.
  // Calibrated on live pages: link-heavy ARTICLES (citation-dense blogs, sites
  // with nav/related-post chrome in the scrape) sit around 1 link per 30-50
  // words, while true link walls run 1 per 6-12 words. Only the latter is a
  // listing, and a declared publish date always vouches for the page.
  if (links >= 30 && density > 0.08 && !publishedAt) {
    return {
      kind: "listing",
      detail: `${links} links across ${words} words with no publish date`,
    };
  }
  return { kind: "article", detail: `${links} links across ${words} words` };
}

function declaredPageTypes(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const candidates = [
    meta.ogType,
    meta["og:type"],
    ...jsonLdTypes(meta.jsonLd ?? meta["json-ld"] ?? meta.structuredData),
  ];
  return candidates
    .filter((value): value is string => typeof value === "string")
    .map(value => value.toLowerCase().replace(/[^a-z]/g, ""))
    .filter(Boolean);
}

function jsonLdTypes(jsonLd: unknown): unknown[] {
  const blocks = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [];
  return blocks.flatMap(block => {
    if (!block || typeof block !== "object") return [];
    const type = (block as Record<string, unknown>)["@type"];
    return Array.isArray(type) ? type : type ? [type] : [];
  });
}

function publishedDate(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const meta = (
    metadata && typeof metadata === "object" ? metadata : {}
  ) as Record<string, unknown>;
  const value =
    meta.publishedTime ||
    meta["article:published_time"] ||
    meta.publishedDate ||
    meta.datePublished ||
    meta.date;
  if (!value || typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function countLinks(markdown: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    index = markdown.indexOf("](", index);
    if (index === -1) break;
    count += 1;
    index += 2;
  }
  // Bare URLs outside markdown link syntax still count toward link mass.
  index = 0;
  for (;;) {
    index = markdown.indexOf("http://", index);
    if (index === -1) break;
    count += 1;
    index += 7;
  }
  index = 0;
  for (;;) {
    index = markdown.indexOf("https://", index);
    if (index === -1) break;
    count += 1;
    index += 8;
  }
  // Markdown links were double-counted (the "](https://" form) — correct that.
  return Math.max(0, Math.round(count / 2));
}

function hostOf(url: string): string {
  try {
    return new URL(String(url ?? "")).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

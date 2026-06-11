import { containsAlias, tokenizeContent, type GoalCriteria } from "./criteria";

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
  claimText: string;
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

  if (
    criteria.subjectAliases.length > 0 &&
    hasPageContent &&
    pageBackedText.trim()
  ) {
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

  const shape = classifyPageShape(evidence);
  if (shape.kind === "listing") {
    failures.push({ check: "listing_surface", detail: shape.detail });
  }

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

import type { Logger } from "winston";
import type { WebSearchResult } from "../lib/entities";
import { fetchResearchUpstream } from "../lib/research-upstream";
import type { CategoryOption } from "../lib/search-query-builder";

const DEVELOPER_QUERY_KEYS = ["query", "k"];

export function wantsDeveloperCategory(categories?: CategoryOption[]): boolean {
  return (categories ?? []).some(category =>
    typeof category === "string"
      ? category === "developer"
      : category.type === "developer",
  );
}

/**
 * Removes the developer category from a normalized category list. Used by the
 * developerBeta gate: an unentitled team's search proceeds without it rather
 * than erroring.
 */
export function stripDeveloperCategory<T extends CategoryOption>(
  categories?: T[],
): T[] | undefined {
  if (categories === undefined) {
    return undefined;
  }
  return categories.filter(category =>
    typeof category === "string"
      ? category !== "developer"
      : category.type !== "developer",
  );
}

/**
 * The zod-inferred category type on SearchRequest is a union of two
 * *homogeneous* arrays (all-string or all-object), not a single array of a
 * union type. TypeScript's generic inference collapses that union to a mixed
 * `(string | CategoryInput)[]` when `stripDeveloperCategory` is called
 * directly on it, which no longer matches either branch on the way back out.
 * Narrowing with this predicate first lets each call site infer `T` as the
 * concrete branch, so the round trip typechecks with no cast.
 */
export function isCategoryStringArray(
  categories: CategoryOption[],
): categories is string[] {
  return categories.every(category => typeof category === "string");
}

export async function searchDeveloperCategory(
  options: { query: string; limit: number; teamId: string; timeout: number },
  logger: Logger,
): Promise<WebSearchResult[]> {
  try {
    const upstream = await fetchResearchUpstream({
      path: "/v2/code/search",
      params: { query: options.query, k: options.limit },
      queryKeys: DEVELOPER_QUERY_KEYS,
      headers: { "firecrawl-team-id": options.teamId },
      timeoutMs: options.timeout,
    });
    if (upstream === null) {
      return [];
    }
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      logger.warn("Developer category upstream failed", {
        status: upstream.status,
      });
      return [];
    }

    const body: any = await upstream.json();
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    return results
      .slice(0, options.limit)
      .map((result, index) => ({
        url: typeof result?.url === "string" ? result.url : "",
        title:
          typeof result?.title === "string" && result.title.trim().length > 0
            ? result.title
            : typeof result?.url === "string"
              ? result.url
              : "",
        description:
          typeof result?.passages?.[0]?.text === "string"
            ? result.passages[0].text
            : "",
        position: index + 1,
        category: "developer",
      }))
      .filter(result => result.url.length > 0);
  } catch (error) {
    logger.warn("Developer category upstream error", { error });
    return [];
  }
}

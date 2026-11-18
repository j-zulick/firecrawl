import { v7 as uuidv7 } from "uuid";
import { config } from "../config";
import { MapDocument, scrapeOptions } from "../controllers/v2/types";
import { scrapeURL } from "../scraper/scrapeURL";
import { useFireEngine } from "../scraper/scrapeURL/engines/fire-engine/available";
import { searxng_search } from "../search/searxng";
import { CostTracking } from "./cost-tracking";
import { logger as _logger } from "./logger";
import { isSameDomain } from "./validateUrl";
import type { WebCrawler } from "../scraper/WebScraper/crawler";

/**
 * Self-hosted /map discovery (j-zulick fork).
 *
 * On the cloud offering /map gets most of its links from fire-engine's search
 * index. A self-hosted install has no fire-engine and (unless DB auth is on) no
 * index, so for any site without a sitemap /map returned nothing. When
 * fire-engine is not configured this adds two cheap discovery sources:
 *
 *   1. A SearXNG `site:` query, when SEARXNG_ENDPOINT is set.
 *   2. Link extraction from the start page, and then from up to
 *      MAP_SELFHOST_DISCOVERY_MAX_PAGES - 1 further same-site pages found on it
 *      (breadth-first, robots.txt respected).
 *
 * Results are merged into the normal map pipeline, which still applies the
 * same-domain, subdomain, path, dedupe and limit filters.
 */
export function shouldUseSelfHostedMapDiscovery(): boolean {
  return !useFireEngine && config.MAP_SELFHOST_DISCOVERY;
}

function siteQuery(url: string, search?: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return search ? `${search} site:${host}` : `site:${host}`;
}

export async function discoverSelfHostedMapLinks({
  url,
  search,
  limit,
  crawler,
  zeroDataRetention,
  allowSearch,
  headers,
  timeoutMs,
  abort,
}: {
  url: string;
  search?: string;
  limit: number;
  crawler: WebCrawler;
  zeroDataRetention: boolean;
  /** False when the team's search zero data retention forbids a search query. */
  allowSearch: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  abort?: AbortSignal;
}): Promise<MapDocument[]> {
  const logger = _logger.child({
    module: "map",
    method: "discoverSelfHostedMapLinks",
  });
  const results: MapDocument[] = [];
  const seen = new Set<string>();
  const add = (doc: MapDocument) => {
    if (!doc.url || seen.has(doc.url)) return;
    seen.add(doc.url);
    results.push(doc);
  };

  const deadline = Date.now() + Math.max(1000, timeoutMs ?? 30000);
  const remaining = () => deadline - Date.now();

  const searxPromise: Promise<void> =
    config.SEARXNG_ENDPOINT && allowSearch
      ? searxng_search(siteQuery(url, search), {
          num_results: Math.min(limit, 100),
        })
          .then(found => {
            for (const r of found) {
              if (r.url && isSameDomain(r.url, url)) {
                add({ url: r.url, title: r.title, description: r.description });
              }
            }
          })
          .catch(error => {
            logger.warn("SearXNG map discovery failed", { error });
          })
      : Promise.resolve();

  const maxPages = Math.max(1, config.MAP_SELFHOST_DISCOVERY_MAX_PAGES);
  const queue: string[] = [url];
  const fetched = new Set<string>();

  while (
    queue.length > 0 &&
    fetched.size < maxPages &&
    results.length < limit &&
    remaining() > 1500 &&
    !abort?.aborted
  ) {
    const pageUrl = queue.shift()!;
    if (fetched.has(pageUrl)) continue;
    fetched.add(pageUrl);
    if (!crawler.isRobotsAllowed(pageUrl)) continue;

    try {
      const response = await scrapeURL(
        "map-discovery;" + uuidv7(),
        pageUrl,
        scrapeOptions.parse({
          formats: ["links"],
          onlyMainContent: false,
          timeout: Math.min(20000, Math.max(1000, remaining() - 500)),
          ...(headers ? { headers } : {}),
        }),
        {
          teamId: "map-discovery",
          orgId: null,
          zeroDataRetention,
          externalAbort: abort
            ? {
                signal: abort,
                tier: "external",
                throwable() {
                  return new Error("Map discovery aborted");
                },
              }
            : undefined,
        },
        new CostTracking(),
      );

      if (!response.success) continue;
      const status = response.document.metadata.statusCode;
      if (status < 200 || status >= 300) continue;
      add({ url: pageUrl });

      for (const link of response.document.links ?? []) {
        let normalized: string;
        try {
          const u = new URL(link, pageUrl);
          if (u.protocol !== "http:" && u.protocol !== "https:") continue;
          u.hash = "";
          normalized = u.href;
        } catch {
          continue;
        }
        if (!isSameDomain(normalized, url)) continue;
        add({ url: normalized });
        if (!fetched.has(normalized) && !crawler.isFile(normalized)) {
          queue.push(normalized);
        }
      }
    } catch (error) {
      logger.warn("Map discovery page fetch failed", { pageUrl, error });
    }
  }

  await searxPromise;
  logger.debug("Self-hosted map discovery finished", {
    url,
    pagesFetched: fetched.size,
    links: results.length,
  });
  return results;
}

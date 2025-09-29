import axios, { AxiosProxyConfig } from "axios";
import { JSDOM } from "jsdom";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";
import https from "https";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

interface SearchOptions {
  tbs?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  timeout?: number;
}

function cleanUrl(href: string): string {
  if (href.includes("uddg=")) {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : href;
  }
  return href;
}

function extractResults(
  document: Document,
  seenUrls: Set<string>,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = Array.from(document.querySelectorAll(".result.web-result"));

  for (const block of blocks) {
    const titleLink = block.querySelector(
      ".result__a",
    ) as HTMLAnchorElement | null;
    const snippet = block.querySelector(".result__snippet");

    if (!titleLink || !snippet) continue;

    const rawUrl = titleLink.href?.trim();
    const title = titleLink.textContent?.trim();
    const description = snippet.textContent?.trim();

    if (rawUrl && title && description) {
      const url = cleanUrl(rawUrl);
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        results.push({ url, title, description });
      }
    }
  }

  return results;
}

function getNextPageData(document: Document): URLSearchParams | null {
  const nextButton = document.querySelector(
    'input[type="submit"][class="btn btn--alt"][value="Next"]',
  ) as HTMLInputElement | null;

  if (!nextButton) return null;

  const nextForm = nextButton.closest("form") as HTMLFormElement | null;
  if (!nextForm) return null;

  const formData = new URLSearchParams();
  const inputs = Array.from(nextForm.querySelectorAll("input"));

  for (const input of inputs) {
    const name = input.getAttribute("name");
    const value = input.getAttribute("value");
    if (name && value !== null) {
      formData.set(name, value);
    }
  }

  return formData;
}

export async function ddgSearch(
  term: string,
  num_results = 5,
  options: SearchOptions = {},
): Promise<SearchV2Response> {
  const {
    lang = "en",
    country = "us",
    location,
    tbs,
    proxy,
    timeout = 5000,
  } = options;

  let proxies: AxiosProxyConfig | false = false;
  if (proxy) {
    const url = new URL(proxy);
    proxies = {
      protocol: url.protocol.slice(0, -1) as "http" | "https",
      host: url.hostname,
      port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
      ...(url.username && {
        auth: { username: url.username, password: url.password },
      }),
    };
  }

  try {
    const userAgent =
      USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    const params = new URLSearchParams({ q: term, kp: "1" });

    if (location) {
      params.set("kl", location);
    } else if (country && lang) {
      params.set("kl", `${country.toLowerCase()}-${lang.toLowerCase()}`);
    }

    if (tbs && (["d", "w", "m", "y"].includes(tbs) || tbs.includes(".."))) {
      params.set("df", tbs);
    }

    const results: WebSearchResult[] = [];
    const seenUrls = new Set<string>();
    let isFirstPage = true;
    let nextPageData: URLSearchParams | null = params;

    while (results.length < num_results && nextPageData) {
      let response;

      if (isFirstPage) {
        response = await axios.get(
          `https://html.duckduckgo.com/html?${params.toString()}`,
          {
            headers: {
              "User-Agent": userAgent,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Accept-Encoding": "gzip, deflate, br",
              "Upgrade-Insecure-Requests": "1",
            },
            proxy: proxies,
            timeout,
            httpsAgent: new https.Agent({ rejectUnauthorized: true }),
          },
        );
        isFirstPage = false;
      } else {
        response = await axios.post(
          "https://html.duckduckgo.com/html/",
          nextPageData.toString(),
          {
            headers: {
              "User-Agent": userAgent,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Accept-Encoding": "gzip, deflate, br",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            proxy: proxies,
            timeout,
            httpsAgent: new https.Agent({ rejectUnauthorized: true }),
          },
        );
      }

      const dom = new JSDOM(response.data);
      const doc = dom.window.document;

      const newResults = extractResults(doc, seenUrls);
      results.push(...newResults);

      if (newResults.length === 0) break;

      nextPageData = getNextPageData(doc);

      await new Promise(r => setTimeout(r, 1000));
    }

    if (results.length === 0) {
      logger.warn("DuckDuckGo: No results found", { term });
      return {};
    }

    return { web: results.slice(0, num_results) };
  } catch (error: any) {
    if (error.response?.status === 429) {
      logger.warn("DuckDuckGo: Too many requests, try again later.", {
        status: error.response.status,
        statusText: error.response.statusText,
      });
      throw new Error("DuckDuckGo: Too many requests, try again later.");
    }
    logger.error("DuckDuckGo search error", { error: error.message, term });
    throw error;
  }
}

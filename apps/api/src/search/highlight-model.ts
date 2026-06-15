import type { Logger } from "winston";
import { config } from "../config";

// Query Highlights model service: a query-finetuned span scorer (no LLM). It was
// trained on the line-like spans `parseMarkdownToSentences` produces, so callers
// pass those spans as explicit `lines`, the service scores each against the
// query, and returns the selected spans as `highlights[]` with their `index`
// back into the input `lines` array. Callers map those indices through
// `assembleAnswer` to rebuild structure (tables/code). We push every page
// through one `/batch_highlight` call (resident GPU model). Endpoint + token are
// config-gated (HIGHLIGHT_MODEL_URL / HIGHLIGHT_MODEL_TOKEN); callers must
// confirm they're set via highlightsEnvReady() before invoking.

// Experimental score cutoff for keeping a span, tuned against the line-span
// format the model was trained on.
const HIGHLIGHT_THRESHOLD = 0.08;
// Cap on how many spans to keep per page after thresholding (highest-scoring).
const HIGHLIGHT_TOP_K = 12;
// Character budget per page; the service keeps the highest-scoring spans until
// the budget is reached (measured on raw span text).
const MAX_HIGHLIGHT_CHARS = 800;
const REQUEST_TIMEOUT_MS = 30000;

interface HighlightItem {
  query: string;
  // Candidate spans for the page, in document order — from
  // parseMarkdownToSentences(markdown).map(s => s.text).
  lines: string[];
}

interface HighlightSpan {
  index?: number;
  score?: number;
}

interface HighlightResult {
  highlights?: HighlightSpan[];
}

interface BatchHighlightResponse {
  results?: HighlightResult[];
}

// Pull the selected span indices out of one page's result. The service already
// applied the threshold / char budget, so we just collect the kept indices.
function selectedIndices(result: HighlightResult | undefined): number[] {
  const highlights = result?.highlights ?? [];
  const out: number[] = [];
  for (const h of highlights) {
    if (typeof h.index === "number" && Number.isInteger(h.index)) {
      out.push(h.index);
    }
  }
  return out;
}

/**
 * Score many pages' candidate spans in a single batch call to the
 * query-highlights model. Returns an array aligned to `items`: for each page,
 * the indices (into that page's `lines`) the model selected, or null when the
 * whole batch fails (so callers can keep the provider snippet). A page with no
 * spans clearing the threshold yields an empty array, not null.
 */
export async function generateHighlightsBatch(
  items: HighlightItem[],
  opts: { logger: Logger },
): Promise<(number[] | null)[]> {
  if (items.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${config.HIGHLIGHT_MODEL_URL}/batch_highlight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.HIGHLIGHT_MODEL_TOKEN}`,
      },
      body: JSON.stringify({
        requests: items.map(item => ({
          query: item.query,
          lines: item.lines,
          threshold: HIGHLIGHT_THRESHOLD,
          top_k: HIGHLIGHT_TOP_K,
          max_highlight_chars: MAX_HIGHLIGHT_CHARS,
        })),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `highlight model HTTP ${res.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await res.json()) as BatchHighlightResponse;
    const results = data.results ?? [];
    const indices = items.map((_, i) => selectedIndices(results[i]));

    opts.logger.info("query highlights batch generated", {
      pages: items.length,
      withHighlights: indices.filter(x => x.length > 0).length,
      elapsedMs: Date.now() - start,
    });

    return indices;
  } catch (error) {
    opts.logger.warn("query highlights batch failed", {
      error: error instanceof Error ? error.message : String(error),
      pages: items.length,
    });
    return items.map(() => null);
  } finally {
    clearTimeout(timer);
  }
}

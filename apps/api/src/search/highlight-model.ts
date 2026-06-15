import type { Logger } from "winston";
import { config } from "../config";

// Query Highlights model service: a query-finetuned span scorer (no LLM). It
// splits each page's markdown into line-like candidate spans — the same shape
// the model was trained on — scores every span against the query, and returns
// the selected spans concatenated in page order as `pruned_markdown`. The
// service keeps a resident GPU model, so we send every page through one
// `/batch_highlight` call instead of one request per page. Endpoint + token are
// config-gated (HIGHLIGHT_MODEL_URL / HIGHLIGHT_MODEL_TOKEN); callers must
// confirm they're set via highlightsEnvReady() before invoking.

// Experimental score cutoff for keeping a span, tuned against the line-span
// format the model was trained on.
const HIGHLIGHT_THRESHOLD = 0.08;
// Character budget for the assembled snippet; the service keeps the
// highest-scoring spans until the budget is reached.
const MAX_HIGHLIGHT_CHARS = 800;
const REQUEST_TIMEOUT_MS = 30000;

interface HighlightItem {
  query: string;
  markdown: string;
}

interface HighlightResult {
  pruned_markdown?: string;
}

interface BatchHighlightResponse {
  results?: HighlightResult[];
}

// The service returns the selected spans joined with "\n" (often with a trailing
// newline). Trim to a clean snippet; null when nothing was selected.
function prunedToSnippet(result: HighlightResult | undefined): string | null {
  const pruned = result?.pruned_markdown;
  if (typeof pruned !== "string") return null;
  const trimmed = pruned.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Generate query-relevant highlights for many pages in a single batch call to
 * the query-highlights model. Each page's markdown is sent as-is; the service
 * splits it into the line-like spans used in training, scores them against the
 * query, and returns the selected spans joined in page order
 * (`pruned_markdown`). Returns an array aligned to `items`: the highlight
 * snippet for each page, or null when nothing clears the threshold (or the whole
 * batch fails — highlights are best-effort, callers keep the provider snippet).
 */
export async function generateHighlightsBatch(
  items: HighlightItem[],
  opts: { logger: Logger },
): Promise<(string | null)[]> {
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
          markdown: item.markdown,
          threshold: HIGHLIGHT_THRESHOLD,
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
    const snippets = items.map((_, i) => prunedToSnippet(results[i]));

    opts.logger.info("query highlights batch generated", {
      pages: items.length,
      withHighlights: snippets.filter(Boolean).length,
      elapsedMs: Date.now() - start,
    });

    return snippets;
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

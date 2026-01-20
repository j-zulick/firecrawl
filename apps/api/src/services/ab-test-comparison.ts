import { Logger } from "winston";
import gitDiff from "git-diff";
import parseDiff from "parse-diff";

const AB_LOG_PREFIX = "[FE_AB_COMPARE]";
const DIFF_THRESHOLD_PERCENT = 5;
const MAX_CONTENT_SIZE = 1000000; // 1 MB

export interface FireEngineResponse {
  content: string;
  pageStatusCode: number;
  timeTaken: number;
}

export interface MirrorResult {
  response: FireEngineResponse | null;
  error: Error | null;
  timeTaken: number;
}

interface ContentDiffResult {
  identical: boolean;
  skipped?: boolean;
  skipReason?: string;
  addedLines?: number;
  removedLines?: number;
  diffPercentage?: number;
}

function computeContentDiff(
  productionContent: string,
  mirrorContent: string,
): ContentDiffResult {
  // Skip if content too large
  if (
    productionContent.length > MAX_CONTENT_SIZE ||
    mirrorContent.length > MAX_CONTENT_SIZE
  ) {
    return { identical: false, skipped: true, skipReason: "content_too_large" };
  }

  // Tier 1: Quick normalized comparison
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  if (normalize(productionContent) === normalize(mirrorContent)) {
    return { identical: true };
  }

  // Tier 2: Compute line diff
  const diffText = gitDiff(productionContent, mirrorContent, {
    color: false,
    wordDiff: false,
  });

  if (!diffText) {
    return { identical: true };
  }

  const parsed = parseDiff(diffText);
  let addedLines = 0;
  let removedLines = 0;

  for (const file of parsed) {
    addedLines += file.additions;
    removedLines += file.deletions;
  }

  const totalLines = productionContent.split("\n").length;
  const diffPercentage =
    totalLines > 0 ? ((addedLines + removedLines) / totalLines) * 100 : 0;

  return {
    identical: false,
    addedLines,
    removedLines,
    diffPercentage: Math.round(diffPercentage * 100) / 100,
  };
}

async function runComparison(
  url: string,
  productionResponse: FireEngineResponse,
  productionTimeTaken: number,
  mirrorPromise: Promise<MirrorResult>,
  abLogger: Logger,
): Promise<void> {
  const mirrorResult = await mirrorPromise;

  if (mirrorResult.error || !mirrorResult.response) {
    abLogger.warn(
      `${AB_LOG_PREFIX} Mirror request failed - unable to compare`,
      {
        url,
        error: mirrorResult.error?.message ?? "unknown",
        prod_ms: productionTimeTaken,
      },
    );
    return;
  }

  const contentDiff = computeContentDiff(
    productionResponse.content,
    mirrorResult.response.content,
  );

  const baseLogData = {
    url,
    prod_ms: productionTimeTaken,
    mirror_ms: mirrorResult.timeTaken,
    diff_ms: mirrorResult.timeTaken - productionTimeTaken,
  };

  if (contentDiff.skipped) {
    abLogger.info(`${AB_LOG_PREFIX} Comparison skipped - content too large`, {
      ...baseLogData,
      skip_reason: contentDiff.skipReason,
    });
    return;
  }

  if (contentDiff.identical) {
    abLogger.info(`${AB_LOG_PREFIX} Content identical`, baseLogData);
    return;
  }

  const diffLogData = {
    ...baseLogData,
    diff_pct: contentDiff.diffPercentage,
    added: contentDiff.addedLines,
    removed: contentDiff.removedLines,
  };
  const diffMessage = `+${contentDiff.addedLines}/-${contentDiff.removedLines} lines, ${contentDiff.diffPercentage}%`;

  if (contentDiff.diffPercentage! > DIFF_THRESHOLD_PERCENT) {
    abLogger.warn(
      `${AB_LOG_PREFIX} Content mismatch detected (${diffMessage})`,
      diffLogData,
    );
  } else {
    abLogger.info(
      `${AB_LOG_PREFIX} Minor content differences (${diffMessage})`,
      diffLogData,
    );
  }
}

export function scheduleABComparison(
  url: string,
  productionResponse: FireEngineResponse,
  productionTimeTaken: number,
  mirrorPromise: Promise<MirrorResult>,
  logger: Logger,
): void {
  const abLogger = logger.child({ method: "ABTestComparison" });

  runComparison(
    url,
    productionResponse,
    productionTimeTaken,
    mirrorPromise,
    abLogger,
  ).catch(error => {
    abLogger.error(`${AB_LOG_PREFIX} comparison failed unexpectedly`, {
      error,
      url,
    });
  });
}

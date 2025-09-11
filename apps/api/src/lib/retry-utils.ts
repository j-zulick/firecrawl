import * as Sentry from "@sentry/node";
import { logger } from "./logger";

const RETRY_DELAYS = [500, 1500, 3000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

/**
 * Abortable sleep function that resolves immediately if the signal is aborted
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    const abortHandler = () => {
      clearTimeout(timeoutId);
      resolve();
    };

    signal?.addEventListener("abort", abortHandler, { once: true });
  });
}

/**
 * Generic retry utility that executes an operation with exponential backoff
 * @param operation - The async operation to retry
 * @param hasValidResult - Function to check if the result is valid/complete
 * @param signal - Optional AbortSignal to cancel the operation
 * @param maxAttempts - Maximum number of attempts (defaults to 4)
 * @param retryDelays - Array of delay times in ms between retries
 * @returns The result of the operation or null if all attempts fail
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T | null>,
  hasValidResult: (result: T | null) => result is T,
  signal?: AbortSignal,
  maxAttempts: number = MAX_ATTEMPTS,
  retryDelays: readonly number[] = RETRY_DELAYS,
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) break;

    try {
      const result = await operation();

      if (hasValidResult(result)) {
        return result;
      }
    } catch (error) {
      logger.error(`Attempt ${attempt + 1} failed:`, error);
      Sentry.captureException(error);
    }

    // Wait before retry (except on last attempt)
    if (attempt < retryDelays.length) {
      await abortableSleep(retryDelays[attempt], signal);
    }
  }

  return null;
}

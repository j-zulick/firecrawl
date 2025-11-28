// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { logger } from "../lib/logger";

if (process.env.SENTRY_DSN) {
  logger.info("Setting up Sentry...");

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: integrations => [...integrations, nodeProfilingIntegration()],
    tracesSampleRate: 0,
    serverName: process.env.NUQ_POD_NAME,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    skipOpenTelemetrySetup: true,
  });
}

/**
 * Set the service type tag for this Sentry instance
 * This helps distinguish between API server and worker errors in Sentry
 */
export function setSentryServiceTag(serviceType: string) {
  if (process.env.SENTRY_DSN) {
    Sentry.setTag("service_type", serviceType);
  }
}

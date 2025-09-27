import { supabase_service } from "../supabase";
import { FirecrawlJob } from "../../types";
import { posthog } from "../posthog";
import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { configDotenv } from "dotenv";
import { saveJobToGCS } from "../../lib/gcs-jobs";
import { saveJobToBigQuery } from "../../lib/bigquery-jobs";
import { transformJobForLogging, createJobLoggerContext } from "../../lib/job-transform";
configDotenv();


export async function logJob(
  job: FirecrawlJob,
  force: boolean = false,
  bypassLogging: boolean = false,
) {
  let logger = _logger.child({
    module: "log_job",
    method: "logJob",
    ...createJobLoggerContext(job),
  });

  const zeroDataRetention = job.zeroDataRetention ?? false;

  logger = logger.child({
    zeroDataRetention,
  });

  try {
    // Save to GCS if configured
    if (process.env.GCS_BUCKET_NAME) {
      await saveJobToGCS(job);
    }

    // Save to BigQuery if configured
    if (process.env.BIGQUERY_DATASET_ID) {
       saveJobToBigQuery(job, force).catch(error => {
        logger.error("Error saving job to BigQuery", { error });
      });
    }

    const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
    if (!useDbAuthentication) {
      return;
    }

    // Redact any pages that have an authorization header
    // actually, Don't. we use the db to retrieve results now. this breaks authed crawls - mogery
    // if (
    //   job.scrapeOptions &&
    //   job.scrapeOptions.headers &&
    //   job.scrapeOptions.headers["Authorization"]
    // ) {
    //   job.scrapeOptions.headers["Authorization"] = "REDACTED";
    //   job.docs = [
    //     {
    //       content: "REDACTED DUE TO AUTHORIZATION HEADER",
    //       html: "REDACTED DUE TO AUTHORIZATION HEADER",
    //     },
    //   ];
    // }
    const jobColumn = transformJobForLogging(job, {
      includeTimestamp: false,
      serializeObjects: false,
      cleanNullValues: true,
    });

    if (bypassLogging) {
      return;
    }

    if (force) {
      let i = 0,
        done = false;
      while (i++ <= 10) {
        try {
          const { error } = await supabase_service
            .from("firecrawl_jobs")
            .insert([jobColumn]);
          if (error) {
            logger.error(
              "Failed to log job due to Supabase error -- trying again",
              { error },
            );
            await new Promise<void>(resolve => setTimeout(() => resolve(), 75));
          } else {
            done = true;
            break;
          }
        } catch (error) {
          logger.error(
            "Failed to log job due to thrown error -- trying again",
            { error },
          );
          await new Promise<void>(resolve => setTimeout(() => resolve(), 75));
        }
      }
      if (done) {
        logger.debug("Job logged successfully!");
      } else {
        logger.error("Failed to log job!");
      }
    } else {
      const { error } = await supabase_service
        .from("firecrawl_jobs")
        .insert([jobColumn]);
      if (error) {
        logger.error(`Error logging job`, {
          error,
        });
      } else {
        logger.debug("Job logged successfully!");
      }
    }

    if (process.env.POSTHOG_API_KEY && !job.crawl_id) {
      const jobProperties = transformJobForLogging(job, {
        includeTimestamp: false,
        serializeObjects: false,
        cleanNullValues: false,
      });

      let phLog = {
        distinctId: "from-api", //* To identify this on the group level, setting distinctid to a static string per posthog docs: https://posthog.com/docs/product-analytics/group-analytics#advanced-server-side-only-capturing-group-events-without-a-user
        ...(job.team_id !== "preview" &&
          !job.team_id?.startsWith("preview_") && {
            groups: { team: job.team_id },
          }), //* Identifying event on this team
        event: "job-logged",
        properties: {
          ...jobProperties,
          // Remove docs from PostHog as it's not needed for analytics
          docs: undefined,
        },
      };
      if (job.mode !== "single_urls") {
        posthog.capture(phLog);
      }
    }
  } catch (error) {
    logger.error(`Error logging job`, {
      error,
    });
  }
}

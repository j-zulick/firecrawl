import { v4 as uuidv4 } from "uuid";
import { ScrapeJobData } from "../types";
import { logger as _logger } from "../lib/logger";
import { getJobFromGCS, removeJobFromGCS } from "../lib/gcs-jobs";
import { Document } from "../controllers/v1/types";
import { Logger } from "winston";
import { ScrapeJobTimeoutError, TransportableError } from "../lib/error";
import { deserializeTransportableError } from "../lib/error-serde";
import { abTestJob } from "./ab-test";
import { NuQJob, scrapeQueue } from "./worker/nuq";
import { serializeTraceContext } from "../lib/otel-tracer";

export async function addScrapeJob(
  webScraperOptions: ScrapeJobData,
  jobId: string = uuidv4(),
  priority: number = 0,
  directToBullMQ: boolean = false,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData> | null> {
  // Capture trace context to propagate to worker
  const traceContext = serializeTraceContext();
  const optionsWithTrace: ScrapeJobData = {
    ...webScraperOptions,
    traceContext,
  };

  if (webScraperOptions.mode === "single_urls") {
    abTestJob(webScraperOptions);
  }

  return await scrapeQueue.addJob(jobId, webScraperOptions, {
    priority,
    listenable,
    ownerId: webScraperOptions.team_id,
    groupId: webScraperOptions.crawl_id ?? undefined,
    timesOutAt: webScraperOptions.crawl_id
      ? undefined
      : new Date(
          Date.now() +
            ((webScraperOptions as any).scrapeOptions?.timeout ?? 300) * 1000,
        ),
  });
}

export async function addScrapeJobs(
  jobs: {
    jobId: string;
    data: ScrapeJobData;
    priority: number;
    listenable?: boolean;
  }[],
) {
  if (jobs.length === 0) return true;

  // Capture trace context for all jobs
  const traceContext = serializeTraceContext();

  for (const job of jobs) {
    if (job.data.mode === "single_urls") {
      abTestJob(job.data);
    }
  }

  await scrapeQueue.addJobs(
    jobs.map(job => ({
      data: {
        ...job.data,
        traceContext,
      },
      id: job.jobId,
      options: {
        priority: job.priority,
        listenable: job.listenable,
        ownerId: job.data.team_id,
        groupId: job.data.crawl_id ?? undefined,
      },
    })),
  );
}

export async function waitForJob(
  job: NuQJob<ScrapeJobData> | string,
  timeout: number | null,
  zeroDataRetention: boolean,
  logger: Logger = _logger,
): Promise<Document> {
  const jobId = typeof job == "string" ? job : job.id;
  const isConcurrencyLimited = !!(typeof job === "string");

  let doc: Document | null = null;
  try {
    doc = await Promise.race(
      [
        scrapeQueue.waitForJob(
          jobId,
          timeout !== null ? timeout + 100 : null,
          logger,
        ),
        timeout !== null
          ? new Promise<Document>((_resolve, reject) => {
              setTimeout(() => {
                reject(
                  new ScrapeJobTimeoutError(
                    "Scrape timed out" +
                      (isConcurrencyLimited
                        ? " after waiting in the concurrency limit queue"
                        : ""),
                  ),
                );
              }, timeout);
            })
          : null,
      ].filter(x => x !== null),
    );
  } catch (e) {
    if (e instanceof TransportableError) {
      throw e;
    } else if (e instanceof Error) {
      const x = deserializeTransportableError(e.message);
      if (x) {
        throw x;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }
  logger.debug("Got job");

  if (!doc) {
    const docs = await getJobFromGCS(jobId);
    logger.debug("Got job from GCS");
    if (!docs || docs.length === 0) {
      throw new Error("Job not found in GCS");
    }
    doc = docs[0]!;

    if (zeroDataRetention) {
      await removeJobFromGCS(jobId);
    }
  }

  return doc;
}

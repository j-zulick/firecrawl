import "dotenv/config";
import "../sentry";
import * as Sentry from "@sentry/node";
import { Job, Queue, Worker } from "bullmq";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getRedisConnection,
  getBillingQueue,
  getPrecrawlQueue,
  precrawlQueueName,
} from "../queue-service";
import {
  processBillingBatch,
  queueBillingOperation,
  startBillingBatchProcessing,
} from "../billing/batch_billing";
import systemMonitor from "../system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  index_supabase_service,
  processIndexInsertJobs,
  processIndexRFInsertJobs,
  processOMCEJobs,
  processDomainFrequencyJobs,
  queryDomainsForPrecrawl,
} from "..";
import { getSearchIndexClient } from "../../lib/search-index-client";
// Search indexing is now handled by the separate search service
// import { processSearchIndexJobs } from "../../lib/search-index/queue";
import { processWebhookInsertJobs } from "../webhook";
import {
  scrapeOptions as scrapeOptionsSchema,
  crawlRequestSchema,
  toV0CrawlerOptions,
} from "../../controllers/v2/types";
import { StoredCrawl, crawlToCrawler, saveCrawl } from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../queue-jobs";
import { BullMQOtel } from "bullmq-otel";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";

const workerLockDuration = Number(process.env.WORKER_LOCK_DURATION) || 60000;
const workerStalledCheckInterval =
  Number(process.env.WORKER_STALLED_CHECK_INTERVAL) || 30000;
const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

const runningJobs: Set<string> = new Set();

// Create a processor for billing jobs
const processBillingJobInternal = async (token: string, job: Job) => {
  if (!job.id) {
    throw new Error("Job has no ID");
  }

  const logger = _logger.child({
    module: "billing-worker",
    method: "processBillingJobInternal",
    jobId: job.id,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on billing job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  let err = null;
  try {
    // Check job type - it could be either a batch processing trigger or an individual billing operation
    if (job.name === "process-batch") {
      // Process the entire batch
      logger.info("Received batch process trigger job");
      await processBillingBatch();
    } else if (job.name === "bill_team") {
      // This is an individual billing operation that should be queued for batch processing
      const { team_id, subscription_id, credits, is_extract, api_key_id } =
        job.data;

      logger.info(`Adding team ${team_id} billing operation to batch queue`, {
        credits,
        is_extract,
        originating_job_id: job.data.originating_job_id,
      });

      // Add to the REDIS batch queue
      await queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id ?? null,
        is_extract,
      );
    } else {
      logger.warn(`Unknown billing job type: ${job.name}`);
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing billing job", { error });
    Sentry.captureException(error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }

  return err;
};

const processPrecrawlJobInternal_legacy = async (token: string, job: Job) => {
  const logger = _logger.child({
    module: "index-worker",
    method: "processPrecrawlJobInternal",
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on precrawl job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  const teamId = process.env.PRECRAWL_TEAM_ID!;

  try {
    const budget = 100000;
    const { data, error } = await index_supabase_service.rpc(
      "precrawl_get_top_domains",
      {
        i_newer_than: new Date(
          Date.now() - 1000 * 60 * 60 * 24 * 7,
        ).toISOString(),
      },
    );

    if (error) {
      logger.error("Error getting top domains", { error });
      throw error;
    }

    const total_hits = data.reduce((a, x) => a + x.count, 0);
    for (const item of data) {
      try {
        const urlObj = new URL(item.example_url);
        urlObj.pathname = "/";
        urlObj.search = "";
        urlObj.hash = "";

        const url = urlObj.toString();

        const limit = Math.round((item.count / total_hits) * budget);

        logger.info("Running pre-crawl", {
          url,
          limit,
          hits: item.count,
          budget,
        });

        const crawlerOptions = {
          ...crawlRequestSchema.parse({ url, limit }),
          url: undefined,
          scrapeOptions: undefined,
        };
        const scrapeOptions = scrapeOptionsSchema.parse({});

        const sc: StoredCrawl = {
          originUrl: url,
          crawlerOptions: toV0CrawlerOptions(crawlerOptions),
          scrapeOptions,
          internalOptions: {
            disableSmartWaitCache: true,
            teamId,
            saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
              ? true
              : false,
            zeroDataRetention: true,
          }, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
          team_id: teamId,
          createdAt: Date.now(),
          maxConcurrency: undefined,
          zeroDataRetention: false,
        };

        const crawlId = uuidv4();

        const crawler = crawlToCrawler(crawlId, sc, null);

        try {
          sc.robots = await crawler.getRobotsTxt(
            scrapeOptions.skipTlsVerification,
          );
          // const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
          // if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
          //   sc.crawlerOptions.delay = robotsCrawlDelay;
          // }
        } catch (e) {
          logger.debug("Failed to get robots.txt (this is probably fine!)", {
            error: e,
          });
        }

        await saveCrawl(crawlId, sc);

        await _addScrapeJobToBullMQ(
          {
            url: url,
            mode: "kickoff" as const,
            team_id: teamId,
            crawlerOptions,
            scrapeOptions: sc.scrapeOptions,
            internalOptions: sc.internalOptions,
            origin: "precrawl",
            integration: null,
            crawl_id: crawlId,
            webhook: undefined,
            v1: true,
            zeroDataRetention: false,
            apiKeyId: null,
          },
          crypto.randomUUID(),
        );
      } catch (e) {
        logger.error("Error processing one cycle of the precrawl job", {
          error: e,
        });
      }
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing precrawl job", { error });
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }
};

// TODO: cron job for triggering this + updating index
const processPrecrawlJob = async (token: string, job: Job) => {
  const logger = _logger.child({
    module: "index-worker",
    method: "processPrecrawlJob",
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on precrawl job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  // set to false to enable actual crawling
  const DRY_RUN = true;

  const MAX_PRE_CRAWL_BUDGET = 10_000; // maximum number of pages to precrawl this job

  const MAX_PRE_CRAWL_DOMAINS = 2000; // maximum number of domains to precrawl
  const MIN_DOMAIN_PRIORITY = 2.0; // minimum priority score to consider a domain
  const MIN_DOMAIN_EVENTS = 1000; // minimum number of events to consider a domain

  const DOMAIN_URL_BATCH_SIZE = 25; // number of domain hashes to query in parallel

  const MIN_URLS_PER_DOMAIN = 10;
  const MAX_URLS_PER_DOMAIN = 500;

  const teamId = process.env.PRECRAWL_TEAM_ID;

  try {
    const dateFuture = new Date();
    dateFuture.setHours(dateFuture.getHours() + 1);

    const domains = await queryDomainsForPrecrawl(
      dateFuture,
      MIN_DOMAIN_EVENTS,
      MIN_DOMAIN_PRIORITY,
      MAX_PRE_CRAWL_DOMAINS,
      logger,
    ).then(domains => {
      return domains
        .map(d => ({
          ...d,
          priority: Math.sqrt(d.priority),
        }))
        .sort((a, b) => b.priority - a.priority);
    });

    if (domains.length === 0) {
      logger.info("No domains due for precrawl, skipping job");
      await job.moveToCompleted({ success: true }, token, false);
      return;
    }

    logger.info(`Found ${domains.length} domains for precrawl`);

    const minPriority = Math.min(...domains.map(d => d.priority));
    const maxPriority = Math.max(...domains.map(d => d.priority));

    logger.info(
      `Domain priority range: ${minPriority.toFixed(
        2,
      )} - ${maxPriority.toFixed(2)}`,
    );

    // TODO: tweak total budget calculation
    const totalBudget = (() => {
      const n = domains.length;
      if (n <= 25) return Math.min(MAX_PRE_CRAWL_BUDGET, 3000 + (n - 1) * 500);
      if (n <= 100)
        return Math.min(MAX_PRE_CRAWL_BUDGET, 10000 + (n - 5) * 200);
      return MAX_PRE_CRAWL_BUDGET;
    })();

    const totalPriority = domains.reduce(
      (sum, x) => Number(sum) + Number(x.priority),
      0,
    );

    const domainQueries = domains.map(d => {
      const normalizedPriority =
        (d.priority - minPriority) / (maxPriority - minPriority);

      const urlsToFetch = Math.round(
        MIN_URLS_PER_DOMAIN +
          Math.pow(normalizedPriority, 2) *
            (MAX_URLS_PER_DOMAIN - MIN_URLS_PER_DOMAIN),
      );

      return {
        hash: d.domain_hash,
        priority: d.priority,
        urlsToFetch,
      };
    });

    const batches: (typeof domainQueries)[] = [];
    for (let i = 0; i < domainQueries.length; i += DOMAIN_URL_BATCH_SIZE) {
      batches.push(domainQueries.slice(i, i + DOMAIN_URL_BATCH_SIZE));
    }

    type TopUrlResult = {
      url: string;
      domain_hash: string;
      event_count: number;
      rank: number;
    };

    const topUrlResults: PromiseSettledResult<{
      data: TopUrlResult[] | null;
      error: any;
    }>[] = [];

    // TODO: optimise this
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      const batchFutures = batch.map(({ hash, urlsToFetch }) => {
        return index_supabase_service
          .rpc("query_top_urls_for_domain", {
            p_domain_hash: hash,
            p_time_window: "7 days",
            p_top_n: urlsToFetch,
          })
          .overrideTypes<TopUrlResult[]>();
      });

      const batchResults = (await Promise.allSettled(
        batchFutures,
      )) as PromiseSettledResult<{ data: TopUrlResult[] | null; error: any }>[];

      topUrlResults.push(...batchResults);

      if (i < batches.length - 1) {
        const waitTime = Math.min(1000 + i * 100, 3000);
        logger.info(
          `Completed batch ${i + 1}/${batches.length} of URL fetches (failed: ${batchResults.filter(r => r.status === "rejected" || (r.status === "fulfilled" && r.value.error)).length}) -> waiting for ${waitTime}ms before next batch...`,
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    let failedBatches = 0;
    const topUrls: TopUrlResult[] = [];
    for (const r of topUrlResults) {
      if (r.status === "fulfilled") {
        if (r.value.error) {
          if (r.value.error.code !== "57014") {
            // query cancelled (likely timeout, need to monitor this)
            logger.error("Pre-crawl RPC error", { error: r.value.error });
          }

          failedBatches++;
          continue;
        }

        topUrls.push(...(r.value.data as TopUrlResult[]));
      } else {
        logger.error("Pre-crawl RPC failed", { error: r.reason });
        failedBatches++;
      }
    }

    logger.info(
      `Found ${topUrls.length} URLs for precrawl (${topUrlResults.length - failedBatches}/${failedBatches})`,
    );

    const bucketedByDomain: Map<string, TopUrlResult[]> = new Map();
    for (const item of topUrls) {
      if (!bucketedByDomain.has(item.domain_hash)) {
        bucketedByDomain.set(item.domain_hash, []);
      }
      bucketedByDomain.get(item.domain_hash)!.push(item);
    }

    const crawlTargets: Map<
      string,
      {
        url: string;
        budget: number;
        domainBudget: number;
        eventCount: number;
      }
    > = new Map();

    for (const domain of domains) {
      try {
        const pages = (bucketedByDomain.get(domain.domain_hash) || []) as {
          url: string;
          domain_hash: string;
          event_count: number;
          rank: number;
        }[];

        const totalEvents = pages.reduce(
          (sum: number, s) => sum + s.event_count,
          0,
        );

        const filteredPages = pages.map(s => ({
          domain: new URL(s.url).hostname,
          url: s.url,
          event_count: s.event_count,
          rank: s.rank,
        }));

        const domainBudget = (domain.priority / totalPriority) * totalBudget;

        for (const page of filteredPages) {
          const pageBudget = Math.round(
            (page.event_count / totalEvents) * domainBudget,
          );

          crawlTargets.set(`https://${page.domain}/`, {
            url: `https://${page.domain}/`,
            budget: pageBudget,
            domainBudget,
            eventCount: -1,
          });

          if (page.url) {
            // TODO: check sitemap
            crawlTargets.set(page.url, {
              url: page.url,
              budget: pageBudget,
              domainBudget,
              eventCount: page.event_count,
            });
          }
        }
      } catch (e) {
        logger.error("Error processing one cycle of the precrawl job", {
          error: e,
        });
      }
    }

    if (!DRY_RUN && teamId && crawlTargets.size > 0) {
      logger.info(
        `Pre-crawling ${crawlTargets.size} urls using total budget: ${totalBudget}`,
      );

      let submittedCrawls = 0;

      for (const target of crawlTargets.values()) {
        try {
          const { url, budget: limit } = target;

          const crawlerOptions = {
            ...crawlRequestSchema.parse({ url, limit }),
            url: undefined,
            scrapeOptions: undefined,
          };

          const scrapeOptions = scrapeOptionsSchema.parse({});
          const sc: StoredCrawl = {
            originUrl: url,
            crawlerOptions: toV0CrawlerOptions(crawlerOptions),
            scrapeOptions,
            internalOptions: {
              disableSmartWaitCache: true, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
              teamId,
              saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
                ? true
                : false,
              zeroDataRetention: true,
            },
            team_id: teamId,
            createdAt: Date.now(),
            maxConcurrency: undefined,
            zeroDataRetention: false,
          };

          const crawlId = uuidv4();

          // robots disabled for now
          // const crawler = crawlToCrawler(crawlId, sc, null);
          // try {
          //   sc.robots = await crawler.getRobotsTxt(
          //     scrapeOptions.skipTlsVerification,
          //   );
          //   const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
          //   if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
          //     sc.crawlerOptions.delay = robotsCrawlDelay;
          //   }
          // } catch (e) {
          //   logger.debug("Failed to get robots.txt (this is probably fine!)", {
          //     error: e,
          //   });
          // }

          await saveCrawl(crawlId, sc);

          await _addScrapeJobToBullMQ(
            {
              url: url,
              mode: "kickoff" as const,
              team_id: teamId,
              crawlerOptions,
              scrapeOptions: sc.scrapeOptions,
              internalOptions: sc.internalOptions,
              origin: "precrawl",
              integration: null,
              crawl_id: crawlId,
              webhook: undefined,
              v1: true,
              zeroDataRetention: false,
              apiKeyId: null,
            },
            crypto.randomUUID(),
          );

          submittedCrawls++;
        } catch (e) {
          logger.error("Error adding precrawl job to queue", { error: e });
        }
      }

      if (submittedCrawls !== crawlTargets.size) {
        logger.info(
          `Submitted ${submittedCrawls} crawls, but had ${crawlTargets.size} targets`,
        );
      } else {
        logger.info(`Submitted ${submittedCrawls} crawls`);
      }
    } else {
      logger.info("------------------------------");
      logger.info(`DRY RUN - no crawl jobs submitted: ${crawlTargets.size}`);
      console.log(
        `Calculated pre-crawl targets: (${crawlTargets.size}) ${JSON.stringify(Array.from(crawlTargets.values()).slice(0, 2), null, 2)} ...`,
      );
      logger.info(`Total budget: ${totalBudget}`);
      logger.info("------------------------------");
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing precrawl job", { error });
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

// Generic worker function that can process different job types
const workerFun = async (
  queue: Queue,
  jobProcessor: (token: string, job: Job) => Promise<any>,
) => {
  const logger = _logger.child({ module: "index-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: getRedisConnection(),
    lockDuration: workerLockDuration,
    stalledInterval: workerStalledCheckInterval,
    maxStalledCount: queue.name === precrawlQueueName ? 0 : 10,
    telemetry: new BullMQOtel("firecrawl-bullmq"),
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      logger.info("No longer accepting new jobs. SIGINT");
      break;
    }

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();

    if (!canAcceptConnection) {
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      if (cantAcceptConnectionCount >= 25) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
      }

      await new Promise(resolve =>
        setTimeout(resolve, cantAcceptConnectionInterval),
      );
      continue;
    } else {
      cantAcceptConnectionCount = 0;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      if (job.id) {
        runningJobs.add(job.id);
      }

      await jobProcessor(token, job);

      if (job.id) {
        runningJobs.delete(job.id);
      }

      await new Promise(resolve => setTimeout(resolve, gotJobInterval));
    } else {
      await new Promise(resolve =>
        setTimeout(resolve, connectionMonitorInterval),
      );
    }
  }

  logger.info("Worker loop ended. Waiting for running jobs to finish...");
  while (runningJobs.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  logger.info("All jobs finished. Worker exiting!");
  process.exit(0);
};

const INDEX_INSERT_INTERVAL = 3000;
const WEBHOOK_INSERT_INTERVAL = 15000;
const OMCE_INSERT_INTERVAL = 5000;
const DOMAIN_FREQUENCY_INTERVAL = 10000;
// Search indexing is now handled by separate search service, not this worker
// const SEARCH_INDEX_INTERVAL = 10000;

// Start the workers
(async () => {
  // Start billing worker and batch processing
  startBillingBatchProcessing();
  const billingWorkerPromise = workerFun(
    getBillingQueue(),
    processBillingJobInternal,
  );

  const precrawlWorkerPromise = process.env.PRECRAWL_TEAM_ID
    ? workerFun(getPrecrawlQueue(), processPrecrawlJob)
    : (async () => {
        logger.warn("PRECRAWL_TEAM_ID not set, skipping precrawl worker");
      })();

  const indexInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }

    await withSpan("firecrawl-index-worker-process-insert-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_insert_jobs",
        "index.worker.type": "scheduled",
      });
      await processIndexInsertJobs();
    });
  }, INDEX_INSERT_INTERVAL);

  const webhookInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processWebhookInsertJobs();
  }, WEBHOOK_INSERT_INTERVAL);

  const indexRFInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan(
      "firecrawl-index-worker-process-rf-insert-jobs",
      async span => {
        setSpanAttributes(span, {
          "index.worker.operation": "process_rf_insert_jobs",
          "index.worker.type": "scheduled",
        });
        await processIndexRFInsertJobs();
      },
    );
  }, INDEX_INSERT_INTERVAL);

  const omceInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan("firecrawl-index-worker-process-omce-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_omce_jobs",
        "index.worker.type": "scheduled",
      });
      await processOMCEJobs();
    });
  }, OMCE_INSERT_INTERVAL);

  const domainFrequencyInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan(
      "firecrawl-index-worker-process-domain-frequency-jobs",
      async span => {
        setSpanAttributes(span, {
          "index.worker.operation": "process_domain_frequency_jobs",
          "index.worker.type": "scheduled",
        });
        await processDomainFrequencyJobs();
      },
    );
  }, DOMAIN_FREQUENCY_INTERVAL);

  // Search indexing is now handled by separate search service
  // The search service has its own worker that processes the queue
  // This worker no longer needs to process search index jobs
  
  // Health check for search service (optional)
  const searchClient = getSearchIndexClient();
  if (searchClient) {
    searchClient.health().then(healthy => {
      if (healthy) {
        logger.info("Search service is healthy");
      } else {
        logger.warn("Search service health check failed");
      }
    }).catch(error => {
      logger.error("Search service health check error", { error });
    });
  }

  // Wait for all workers to complete (which should only happen on shutdown)
  await Promise.all([billingWorkerPromise, precrawlWorkerPromise]);

  clearInterval(indexInserterInterval);
  clearInterval(webhookInserterInterval);
  clearInterval(indexRFInserterInterval);
  clearInterval(omceInserterInterval);
  clearInterval(domainFrequencyInterval);
})();

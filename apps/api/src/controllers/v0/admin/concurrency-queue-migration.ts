import type { Request, Response } from "express";
import { logger as _logger } from "../../../lib/logger";
import { redisEvictConnection } from "../../../services/redis";
import { crawlGroup, scrapeQueue } from "../../../services/worker/nuq";
import { getCrawl } from "../../../lib/crawl-redis";

export async function migrateConcurrencyQueue(_: Request, res: Response) {
  const logger = _logger.child({
    module: "admin",
    method: "migrateConcurrencyQueue"
  });

  let crawlsCursor = "0";

  do {
    const crawlsScan = await redisEvictConnection.sscan(
      "ongoing_crawls",
      crawlsCursor
    );
    crawlsCursor = crawlsScan[0];

    for (const crawlId of crawlsScan[1]) {
      const crawlData = (await getCrawl(crawlId)) ?? { maxConcurrency: undefined }

      logger.info("Migrating crawl", { crawlId });

      await crawlGroup.addGroup(crawlId, [
        {
          queue: scrapeQueue,
          maxConcurrency: crawlData.maxConcurrency ?? undefined,
        },
      ]);
    }

  } while (crawlsCursor !== "0");

  let queuesCursor = "0";

  do {
    const queuesScan = await redisEvictConnection.sscan(
      "concurrency-limit-queues",
      queuesCursor,
    );
    queuesCursor = queuesScan[0];

    for (const queueKey of queuesScan[1]) {
      if (queueKey.startsWith("concurrency-limit-queue:preview_")) {
        logger.warn("Skipping preview queue", { queueKey });
        continue;
      }

      let queueCursor = "0";

      logger.info("Migrating a queue", { queueKey });

      do {
        const queueScan = await redisEvictConnection.zscan(
          queueKey,
          queueCursor,
        );
        queueCursor = queueScan[0];

        for (let i = 0; i < queueScan[1].length; i += 2) {
          const jobData = JSON.parse(queueScan[1][i]);
          const jobScore = queueScan[1][i + 1];

          logger.info("Migrating job", { queueKey, teamId: jobData?.data?.teamId, zeroDataRetention: jobData?.data?.zeroDataRetention, scrapeId: jobData?.id });

          const success = await scrapeQueue.tryAddJob(jobData.id, jobData.data, {
            priority: jobData.priority,
            listenable: jobData.listenable,
            ownerId: jobData.data.team_id ?? undefined,
            groupId: jobData.data.crawl_id ?? undefined,
            timesOutAt: jobScore === "inf" ? undefined : new Date(parseInt(jobScore, 10)),
          });

          if (success === null) {
            logger.warn("Failed to migrate job due to conflict", { queueKey, teamId: jobData?.data?.teamId, zeroDataRetention: jobData?.data?.zeroDataRetention, scrapeId: jobData?.id });
          }
        }
      } while (queueCursor !== "0");
    }
  } while (queuesCursor !== "0");

  logger.info("Migration complete! 🎉");

  res.json({ ok: true });
}

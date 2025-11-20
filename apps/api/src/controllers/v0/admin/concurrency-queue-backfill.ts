import { logger as _logger } from "../../../lib/logger";
import { Request, Response } from "express";
import { getRedisConnection } from "../../../services/queue-service";
import { scrapeQueue } from "../../../services/worker/nuq";
import { pushConcurrencyLimitedJob } from "../../../lib/concurrency-limit";

export async function concurrencyQueueBackfillController(
  req: Request,
  res: Response,
) {
  const logger = _logger.child({
    module: "concurrencyQueueBackfillController",
  });

  logger.info("Starting concurrency queue backfill");

  const backloggedOwnerIDs = req.query.teamId
    ? [req.query.teamId as string]
    : await scrapeQueue.getBackloggedOwnerIDs(logger);

  for (const ownerId of backloggedOwnerIDs) {
    logger.info("Backfilling concurrency queue for team", { teamId: ownerId });

    const backloggedJobIDs = new Set(
      await scrapeQueue.getBackloggedJobIDsOfOnwer(ownerId, logger),
    );
    const queuedJobIDs = new Set<string>();

    let cursor = "0";

    do {
      const result = await getRedisConnection().zscan(
        `concurrency-limit-queue:${ownerId}`,
        cursor,
        "COUNT",
        20,
      );
      cursor = result[0];
      const results = result[1];

      results.forEach(x => queuedJobIDs.add(JSON.parse(x).id));
    } while (cursor !== "0");

    const jobIDsToAdd = new Set(
      [...backloggedJobIDs].filter(x => !queuedJobIDs.has(x)),
    );

    logger.info("Team statistics", {
      teamId: ownerId,
      backloggedJobIDs: backloggedJobIDs.size,
      queuedJobIDs: queuedJobIDs.size,
      jobIDsToAdd: jobIDsToAdd.size,
    });

    const jobsToAdd = await scrapeQueue.getJobsFromBacklog(
      Array.from(jobIDsToAdd),
      logger,
    );

    for (const job of jobsToAdd) {
      await pushConcurrencyLimitedJob(
        ownerId,
        {
          id: job.id,
          data: job.data,
          priority: job.priority,
          listenable: job.listenChannelId !== undefined,
        },
        Infinity,
      );
    }

    logger.info("Finished backfilling concurrency queue for team", {
      teamId: ownerId,
    });
  }

  logger.info("Finished backfilling all teams");

  res.json({ ok: true });
}

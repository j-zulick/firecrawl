import { RateLimiterMode } from "../../types";
import { getACUCTeam } from "../auth";
import { AuthCreditUsageChunkFromTeam, RequestWithAuth } from "./types";
import { Response } from "express";
import { redisEvictConnection } from "../../services/redis";
import { scrapeQueue } from "../../services/worker/nuq";

type QueueStatusResponse = {
  success: boolean;
  jobsInQueue: number;
  activeJobsInQueue: number;
  waitingJobsInQueue: number;
  maxConcurrency: number;
  mostRecentSuccess: string | null;
};

export async function queueStatusController(
  req: RequestWithAuth<{}, undefined, QueueStatusResponse>,
  res: Response<QueueStatusResponse>,
) {
  let otherACUC: AuthCreditUsageChunkFromTeam | null = null;
  if (!req.acuc?.is_extract) {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Extract,
    );
  } else {
    otherACUC = await getACUCTeam(
      req.auth.team_id,
      false,
      true,
      RateLimiterMode.Crawl,
    );
  }

  const jobCounts = await scrapeQueue.getOwnerJobCounts(req.auth.team_id);

  const mostRecentSuccess = await redisEvictConnection.get(
    "most-recent-success:" + req.auth.team_id,
  );

  return res.status(200).json({
    success: true,

    jobsInQueue: jobCounts.active + jobCounts.queued,
    activeJobsInQueue: jobCounts.active,
    waitingJobsInQueue: jobCounts.queued,
    maxConcurrency: Math.max(
      req.acuc?.concurrency ?? 1,
      otherACUC?.concurrency ?? 1,
    ),

    mostRecentSuccess: mostRecentSuccess
      ? new Date(mostRecentSuccess).toISOString()
      : null,
  });
}

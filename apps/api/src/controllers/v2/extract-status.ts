import { Response } from "express";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import { getExtract, getExtractExpiry } from "../../lib/extract/extract-redis";
import { getExtractQueue } from "../../services/queue-service";
import { ExtractResult } from "../../lib/extract/extraction-service";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetExtractByIdDirect,
  supabaseGetExtractRequestByIdDirect,
} from "../../lib/supabase-jobs";
import { JobState } from "bullmq";
import { logger as _logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";

type DBExtract = {
  id: string;
  is_successful: boolean;
  options: any;
  created_at: any;
  error: string | null;
  team_id: string;
};

type ExtractPseudoJob<T> = {
  id: string;
  getState: () => Promise<JobState | "unknown"> | JobState | "unknown";
  returnvalue: T | null;
  timestamp: number;
  data: {
    scrapeOptions: any;
    teamId?: string;
  };
  failedReason?: string;
};

async function getExtractJob(
  id: string,
): Promise<ExtractPseudoJob<ExtractResult> | null> {
  const [bullJob, gcsJob, dbExtract] = await Promise.all([
    getExtractQueue().getJob(id),
    (config.GCS_BUCKET_NAME ? getJobFromGCS(id) : null) as Promise<any | null>,
    (config.USE_DB_AUTHENTICATION
      ? supabaseGetExtractByIdDirect(id)
      : null) as Promise<DBExtract | null>,
  ]);

  if (!bullJob && !dbExtract) return null;

  // Extract results are stored in GCS, not in the DB
  let data = gcsJob ?? bullJob?.returnvalue?.data;
  if (gcsJob === null && data) {
    _logger.warn("GCS Job not found", {
      jobId: id,
    });
  }
  if (Array.isArray(data)) data = data[0];

  const job: ExtractPseudoJob<any> = {
    id,
    getState: bullJob
      ? bullJob.getState.bind(bullJob)
      : () => (dbExtract!.is_successful ? "completed" : "failed"),
    returnvalue: data,
    data: {
      scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbExtract!.options,
      teamId: bullJob ? bullJob.data.teamId : dbExtract!.team_id,
    },
    timestamp: bullJob
      ? bullJob.timestamp
      : new Date(dbExtract!.created_at).valueOf(),
    failedReason:
      (bullJob ? bullJob.failedReason : dbExtract!.error) || undefined,
  };

  return job;
}

export async function extractStatusController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  const extractRequest = await supabaseGetExtractRequestByIdDirect(
    req.params.jobId,
  );

  if (!extractRequest || extractRequest.team_id !== req.auth.team_id) {
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  if (extractRequest.kind === "agent") {
    const agent = await supabaseGetAgentByIdDirect(req.params.jobId);

    let data: any = undefined;
    if (agent?.is_successful) {
      data = await getJobFromGCS(agent.id);
    }

    return res.status(200).json({
      success: true,
      status: !agent
        ? "processing"
        : agent.is_successful
          ? "completed"
          : "failed",
      error: agent?.error || undefined,
      data,
      expiresAt: new Date(
        new Date(agent?.created_at ?? extractRequest.created_at).getTime() +
          1000 * 60 * 60 * 24,
      ).toISOString(),
      creditsUsed: agent?.credits_cost,
    });
  }

  let data: ExtractResult | [] = [];
  let status: string = "processing";

  const redisExtract = await getExtract(req.params.jobId);
  const jobData = await getExtractJob(req.params.jobId);

  console.log("jobData", jobData);

  if (jobData) {
    const jobStatus = await jobData.getState();

    if (jobStatus === "completed") {
      status = "completed";
    } else if (jobStatus === "failed") {
      status = "failed";
    } else {
      status = "processing";
    }
  }

  if (!jobData?.returnvalue) {
    // if we got in the split-second where the redis is updated but the bull isn't
    // just pretend it's still processing - MG
    status = "processing";
  } else {
    data = jobData.returnvalue ?? [];
  }

  return res.status(200).json({
    success: status === "failed" ? false : true,
    data,
    status,
    error: jobData?.failedReason,
    expiresAt: redisExtract
      ? (await getExtractExpiry(req.params.jobId)).toISOString()
      : new Date(
          new Date(jobData?.timestamp ?? extractRequest.created_at).getTime() +
            1000 * 60 * 60 * 24,
        ).toISOString(),
    steps: redisExtract?.showSteps ? redisExtract.steps : undefined,
    llmUsage: redisExtract?.showLLMUsage ? redisExtract.llmUsage : undefined,
    sources: redisExtract?.showSources ? redisExtract.sources : undefined,
    costTracking: redisExtract?.showCostTracking
      ? redisExtract.costTracking
      : undefined,
    sessionIds: redisExtract?.sessionIds ? redisExtract.sessionIds : undefined,
    tokensUsed: redisExtract?.tokensBilled
      ? redisExtract.tokensBilled
      : undefined,
    creditsUsed: redisExtract?.creditsBilled
      ? redisExtract.creditsBilled
      : undefined,
  });
}

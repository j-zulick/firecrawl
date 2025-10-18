import {
  ConcurrencyCheckParams,
  ConcurrencyCheckResponse,
  RequestWithAuth,
} from "./types";
import { AuthCreditUsageChunkFromTeam } from "../v1/types";
import { Response } from "express";
import { getACUCTeam } from "../auth";
import { RateLimiterMode } from "../../types";
import { scrapeQueue } from "../../services/worker/nuq";

// Basically just middleware and error wrapping
export async function concurrencyCheckController(
  req: RequestWithAuth<ConcurrencyCheckParams, undefined, undefined>,
  res: Response<ConcurrencyCheckResponse>,
) {
  if (!req.acuc) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  const ownerConcurrency = await scrapeQueue.getOwnerConcurrency(
    req.auth.team_id,
  );

  let maxConcurrency: number | null = ownerConcurrency?.maxConcurrency ?? null;

  if (maxConcurrency === null) {
    let otherACUC: AuthCreditUsageChunkFromTeam | null = null;
    if (!req.acuc.is_extract) {
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

    maxConcurrency = Math.max(
      req.acuc.concurrency,
      otherACUC?.concurrency ?? 0,
    );
  }

  return res.status(200).json({
    success: true,
    concurrency: ownerConcurrency?.currentConcurrency ?? 0,
    maxConcurrency,
  });
}

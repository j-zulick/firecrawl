import { Request, Response } from "express";
import { redisEvictConnection } from "../../../services/redis";
import { getCrawl } from "../../../lib/crawl-redis";
import { supabase_service } from "../../../services/supabase";
import { logger as _logger } from "../../../lib/logger";

type MigrationResult = {
  id: string;
  success: boolean;
  error?: string;
  skipped?: boolean;
};

export async function crawlMigrationController(req: Request, res: Response) {
  const logger = _logger.child({
    module: "admin",
    method: "crawlMigrationController",
  });

  logger.info("Starting crawl migration...");

  // Get all active crawl IDs from Redis
  const activeCrawlIds = await redisEvictConnection.smembers("active_crawls");

  logger.info(`Found ${activeCrawlIds.length} active crawls to migrate`);

  const results: MigrationResult[] = [];

  for (const crawlId of activeCrawlIds) {
    try {
      // Check if requests entry already exists
      const { data: existingRequest } = await supabase_service
        .from("requests")
        .select("id")
        .eq("id", crawlId)
        .single();

      if (existingRequest) {
        logger.debug(`Crawl ${crawlId} already has a requests entry, skipping`);
        results.push({ id: crawlId, success: true, skipped: true });
        continue;
      }

      // Fetch crawl data from Redis
      const crawl = await getCrawl(crawlId);

      if (!crawl) {
        logger.warn(`Crawl ${crawlId} not found in Redis, skipping`);
        results.push({
          id: crawlId,
          success: false,
          error: "Crawl not found in Redis",
        });
        continue;
      }

      // Determine kind: 'crawl' if crawlerOptions !== null, else 'batch_scrape'
      const kind = crawl.crawlerOptions !== null ? "crawl" : "batch_scrape";

      // Insert into requests table
      const { error: insertError } = await supabase_service
        .from("requests")
        .insert({
          id: crawlId,
          kind: kind,
          api_version: "legacy",
          team_id:
            crawl.team_id === "preview" || crawl.team_id?.startsWith("preview_")
              ? null
              : crawl.team_id,
          origin: "migration",
          integration: null,
          target_hint: crawl.zeroDataRetention
            ? "<redacted due to zero data retention>"
            : (crawl.originUrl ?? "<unknown>"),
          dr_clean_by: crawl.zeroDataRetention
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : null,
        });

      if (insertError) {
        logger.error(`Failed to migrate crawl ${crawlId}`, {
          error: insertError,
        });
        results.push({
          id: crawlId,
          success: false,
          error: insertError.message,
        });
      } else {
        logger.info(`Successfully migrated crawl ${crawlId}`, { kind });
        results.push({ id: crawlId, success: true });
      }
    } catch (error) {
      logger.error(`Error migrating crawl ${crawlId}`, { error });
      results.push({
        id: crawlId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const migrated = results.filter(r => r.success && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => !r.success).length;

  logger.info("Crawl migration complete", { migrated, skipped, failed });

  res.status(200).json({
    success: true,
    total: activeCrawlIds.length,
    migrated,
    skipped,
    failed,
    results,
  });
}

import { z } from "zod";
import { webhookSchema } from "./schema";
import { ExtractResult } from "../../lib/extract/extraction-service";
import { Document } from "../../controllers/v2/types";

export enum WebhookEvent {
  CRAWL_STARTED = "crawl.started",
  CRAWL_PAGE = "crawl.page",
  CRAWL_COMPLETED = "crawl.completed",
  BATCH_SCRAPE_STARTED = "batch_scrape.started",
  BATCH_SCRAPE_PAGE = "batch_scrape.page",
  BATCH_SCRAPE_COMPLETED = "batch_scrape.completed",
  EXTRACT_STARTED = "extract.started",
  EXTRACT_COMPLETED = "extract.completed",
  EXTRACT_FAILED = "extract.failed",
}

export type WebhookEventDataMap = {
  [WebhookEvent.CRAWL_STARTED]: CrawlStartedData;
  [WebhookEvent.CRAWL_PAGE]: CrawlPageData;
  [WebhookEvent.CRAWL_COMPLETED]: CrawlCompletedData;
  [WebhookEvent.BATCH_SCRAPE_STARTED]: BatchScrapeStartedData;
  [WebhookEvent.BATCH_SCRAPE_PAGE]: BatchScrapePageData;
  [WebhookEvent.BATCH_SCRAPE_COMPLETED]: BatchScrapeCompletedData;
  [WebhookEvent.EXTRACT_STARTED]: ExtractStartedData;
  [WebhookEvent.EXTRACT_COMPLETED]: ExtractCompletedData;
  [WebhookEvent.EXTRACT_FAILED]: ExtractFailedData;
};

export type WebhookConfig = z.infer<typeof webhookSchema>;

export interface WebhookDocument {
  content?: string;
  markdown: string;
  metadata: Record<string, any>;
}

export interface WebhookDocumentLink {
  content: WebhookDocument;
  source: string;
}

interface BaseWebhookData {
  success: boolean;
  scrapeId?: string;
  awaitWebhook?: boolean;
}

// crawl
export interface CrawlStartedData extends BaseWebhookData {
  success: true;
}

export interface CrawlPageData extends BaseWebhookData {
  success: boolean;
  data: Document[] | WebhookDocumentLink[]; // links or documents (v0 compatible)
  error?: string;
}

export interface CrawlCompletedData extends BaseWebhookData {
  success: true;
  data: Document[] | WebhookDocumentLink[]; // empty array or links (v0 compatible)
}

export interface CrawlFailedData extends BaseWebhookData {
  success: false;
  error: string;
}

// batch scrape
export interface BatchScrapeStartedData extends BaseWebhookData {
  success: true;
}

export interface BatchScrapePageData extends BaseWebhookData {
  success: boolean;
  data: Document[];
  error?: string; // more v0 tomfoolery
}

export interface BatchScrapeCompletedData extends BaseWebhookData {
  success: true;
  data: WebhookDocumentLink[];
}

// extract
export interface ExtractStartedData extends BaseWebhookData {
  success: true;
}

export interface ExtractCompletedData extends BaseWebhookData {
  success: true;
  data: ExtractResult[];
}

export interface ExtractFailedData extends BaseWebhookData {
  success: false;
  error: string;
}

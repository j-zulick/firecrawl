jest.mock("uuid", () => ({
  v7: () => "test-uuid-v7",
}));

import {
  estimateActualCredits,
  isMonitorCheckStale,
  MONITOR_CHECK_STALE_TIMEOUT_MS,
} from "./runner";
import { calculateScrapeJobCredits } from "../worker/scrape-worker";
import { CostTracking } from "../../lib/cost-tracking";
import { TransportableError } from "../../lib/error";

function monitorScrapeJob(
  params: {
    scrapeOptions?: Record<string, any>;
    internalOptions?: Record<string, any>;
    isScrape?: boolean;
  } = {},
) {
  return {
    id: "job-1",
    data: {
      team_id: "team-1",
      scrapeOptions: {
        formats: [{ type: "markdown" }],
        ...(params.scrapeOptions ?? {}),
      },
      internalOptions: {
        teamId: "team-1",
        zeroDataRetention: false,
        bypassBilling: true,
        ...(params.internalOptions ?? {}),
      },
      is_scrape: params.isScrape,
    },
  } as any;
}

async function monitorScrapeCredits(
  params: {
    scrapeOptions?: Record<string, any>;
    internalOptions?: Record<string, any>;
    metadata?: Record<string, any>;
    flags?: Record<string, any>;
    unsupportedFeatures?: Set<any>;
  } = {},
) {
  return await calculateScrapeJobCredits(
    monitorScrapeJob({
      scrapeOptions: params.scrapeOptions,
      internalOptions: params.internalOptions,
    }),
    { metadata: params.metadata ?? { statusCode: 200 } } as any,
    new CostTracking(),
    (params.flags ?? {}) as any,
    null,
    params.unsupportedFeatures,
  );
}

describe("monitoring runner", () => {
  describe("estimateActualCredits", () => {
    it("prefers scrape-reported credits when present", () => {
      expect(estimateActualCredits({ metadata: { creditsUsed: 9 } })).toBe(9);
    });

    it("falls back to one credit when scrape metadata is missing credits", () => {
      expect(estimateActualCredits({ metadata: { numPages: 4 } })).toBe(1);
    });
  });

  describe("calculateScrapeJobCredits", () => {
    it.each([
      ["base scrape", {}, {}, 1],
      ["lockdown", { lockdown: true }, {}, 5],
      ["json format", { formats: [{ type: "json" }] }, {}, 5],
      [
        "change tracking json mode",
        { formats: [{ type: "changeTracking", modes: ["json"] }] },
        {},
        5,
      ],
      ["question format", { formats: [{ type: "question" }] }, {}, 5],
      ["query format", { formats: [{ type: "query" }] }, {}, 5],
      ["highlights format", { formats: [{ type: "highlights" }] }, {}, 5],
      ["audio format", { formats: [{ type: "audio" }] }, {}, 5],
      ["video format", { formats: [{ type: "video" }] }, {}, 5],
      ["ten-page parsed PDF", {}, { numPages: 10 }, 10],
      ["PDF parsing disabled", { parsers: [] }, { numPages: 10 }, 1],
      [
        "json plus three-page PDF",
        { formats: [{ type: "json" }] },
        { numPages: 3 },
        7,
      ],
      ["stealth proxy actually used", {}, { proxyUsed: "stealth" }, 5],
      [
        "X/Twitter postprocessor",
        {},
        { postprocessorsUsed: ["x-twitter"], proxyUsed: "basic" },
        30,
      ],
    ])(
      "matches scrape billing for %s",
      async (_name, scrapeOptions, metadata, expected) => {
        await expect(
          monitorScrapeCredits({ scrapeOptions, metadata }),
        ).resolves.toBe(expected);
      },
    );

    it("stacks independent format bonuses", async () => {
      await expect(
        monitorScrapeCredits({
          scrapeOptions: {
            formats: [
              { type: "markdown" },
              { type: "query" },
              { type: "highlights" },
              { type: "audio" },
              { type: "video" },
            ],
          },
        }),
      ).resolves.toBe(17);
    });

    it("does not charge stealth proxy bonus when unsupported", async () => {
      await expect(
        monitorScrapeCredits({
          metadata: { proxyUsed: "stealth" },
          unsupportedFeatures: new Set(["stealthProxy"]),
        }),
      ).resolves.toBe(1);
    });

    it("uses team-specific ZDR pricing when ZDR is enabled", async () => {
      await expect(
        monitorScrapeCredits({
          internalOptions: { zeroDataRetention: true },
          flags: { zdrCost: 3 },
        }),
      ).resolves.toBe(4);
    });

    it("does not add ZDR pricing on top of lockdown", async () => {
      await expect(
        monitorScrapeCredits({
          scrapeOptions: { lockdown: true },
          internalOptions: { zeroDataRetention: true },
          flags: { zdrCost: 3 },
        }),
      ).resolves.toBe(5);
    });

    it("uses cost tracking for Fire-1 billing", async () => {
      const costTracking = new CostTracking();
      costTracking.addCall({
        type: "other",
        metadata: {},
        cost: 0.01,
        model: "fire-1",
      });

      await expect(
        calculateScrapeJobCredits(
          monitorScrapeJob({
            internalOptions: { v1Agent: { model: "fire-1" } },
          }),
          { metadata: { statusCode: 200 } } as any,
          costTracking,
          {} as any,
        ),
      ).resolves.toBe(18);
    });

    it("still computes credits for bypassed monitor scrapes", async () => {
      await expect(
        calculateScrapeJobCredits(
          monitorScrapeJob({
            scrapeOptions: { formats: [{ type: "json" }] },
            internalOptions: { bypassBilling: true },
          }),
          { metadata: { statusCode: 200 } } as any,
          new CostTracking(),
          {} as any,
        ),
      ).resolves.toBe(5);
    });

    it("does not compute credits for scrape jobs that explicitly opt out", async () => {
      await expect(
        calculateScrapeJobCredits(
          monitorScrapeJob({ isScrape: true }),
          { metadata: { statusCode: 200 } } as any,
          new CostTracking(),
          {} as any,
        ),
      ).resolves.toBeNull();
    });

    it("bills DNS failures consistently with scrape billing", async () => {
      await expect(
        calculateScrapeJobCredits(
          monitorScrapeJob(),
          null,
          new CostTracking(),
          {} as any,
          new TransportableError("SCRAPE_DNS_RESOLUTION_ERROR"),
        ),
      ).resolves.toBe(1);
    });
  });

  describe("isMonitorCheckStale", () => {
    const now = new Date("2026-05-06T12:00:00.000Z");

    it("returns true when a running check is at least 1 hour old", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS,
            ).toISOString(),
            updated_at: now.toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(true);
    });

    it("returns false when a running check is not yet stale", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS + 1,
            ).toISOString(),
            updated_at: now.toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(false);
    });

    it("falls back to updated_at for malformed started_at values", () => {
      expect(
        isMonitorCheckStale(
          {
            started_at: null,
            updated_at: new Date(
              now.getTime() - MONITOR_CHECK_STALE_TIMEOUT_MS,
            ).toISOString(),
            created_at: now.toISOString(),
          },
          now,
        ),
      ).toBe(true);
    });
  });
});

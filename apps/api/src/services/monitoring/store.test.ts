jest.mock("uuid", () => ({
  v7: () => "test-uuid-v7",
}));

import {
  calculateMonitorCheckActualCreditsFromPages,
  estimateMonitorCreditsPerRun,
} from "./store";
import type { MonitorTarget } from "./types";

describe("monitoring store credit helpers", () => {
  it("estimates goal-enabled scrape monitors from scrape option costs", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a", "https://example.com/b"],
        scrapeOptions: {
          formats: [{ type: "changeTracking", modes: ["json"] }],
          proxy: "stealth",
        },
      },
    ];

    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(18);
    expect(estimateMonitorCreditsPerRun(targets, true)).toBe(20);
  });

  it("adds predictable lockdown costs and judge credits separately", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          lockdown: true,
        },
      },
    ];

    expect(estimateMonitorCreditsPerRun(targets, false)).toBe(5);
    expect(estimateMonitorCreditsPerRun(targets, true)).toBe(6);
  });

  it("uses target options when page rows do not have recorded scrape credits", () => {
    const targets: MonitorTarget[] = [
      {
        id: "target-1",
        type: "scrape",
        urls: ["https://example.com/a"],
        scrapeOptions: {
          formats: [{ type: "changeTracking", modes: ["json"] }],
          proxy: "stealth",
        },
      },
    ];

    expect(
      calculateMonitorCheckActualCreditsFromPages(
        [
          {
            target_id: "target-1",
            metadata: {},
            judgment: { meaningful: true },
            status: "changed",
          },
        ],
        targets,
      ),
    ).toBe(10);
  });

  it("prefers recorded page usage and does not bill removed pages", () => {
    expect(
      calculateMonitorCheckActualCreditsFromPages([
        { metadata: { creditsUsed: 5 }, judgment: { meaningful: true } },
        { metadata: { creditsUsed: 1 }, judgment: null },
        { metadata: {}, judgment: { meaningful: false } },
        { status: "removed", metadata: {}, judgment: null },
      ]),
    ).toBe(9);
  });
});

import {
  reconstructKnownState,
  searchStatusToPageStatus,
  searchPageWasScraped,
} from "./persist";
import { canonicalizeUrl } from "./dedupe";

describe("searchStatusToPageStatus", () => {
  it("maps alert→new, skipped→error, rest→same", () => {
    expect(searchStatusToPageStatus("alert")).toBe("new");
    expect(searchStatusToPageStatus("skipped")).toBe("error");
    expect(searchStatusToPageStatus("already_seen")).toBe("same");
    expect(searchStatusToPageStatus("watching")).toBe("same");
    expect(searchStatusToPageStatus("ignored")).toBe("same");
  });
});

describe("searchPageWasScraped", () => {
  it("true only for statuses produced by a successful scrape+judge", () => {
    expect(searchPageWasScraped("alert")).toBe(true);
    expect(searchPageWasScraped("watching")).toBe(true);
    expect(searchPageWasScraped("ignored")).toBe(true);
    expect(searchPageWasScraped("already_seen")).toBe(false);
    expect(searchPageWasScraped("skipped")).toBe(false);
  });
});

describe("reconstructKnownState", () => {
  it("rebuilds the dedup map keyed by canonical URL", () => {
    const { knownPages } = reconstructKnownState(
      [
        {
          url: "https://www.Example.com/A/",
          metadata: { fingerprint: "fp1", goalVersion: "gv1" },
        },
      ],
      "gv1",
    );
    expect(knownPages.get(canonicalizeUrl("https://example.com/a"))).toEqual({
      fingerprint: "fp1",
      goalVersion: "gv1",
    });
  });

  it("loads fingerprints from any goalVersion (the runner gate decides freshness)", () => {
    const { knownPages } = reconstructKnownState(
      [
        {
          url: "https://a.com",
          metadata: { fingerprint: "old", goalVersion: "gvOLD" },
        },
      ],
      "gvNEW",
    );
    expect(knownPages.get(canonicalizeUrl("https://a.com"))?.goalVersion).toBe(
      "gvOLD",
    );
  });

  it("only includes events from the current goalVersion (goal change starts clean)", () => {
    const { knownEvents } = reconstructKnownState(
      [
        {
          url: "https://a.com",
          metadata: {
            fingerprint: "f1",
            goalVersion: "gv1",
            eventKey: "e1",
            eventLabel: "Event One",
          },
        },
        {
          url: "https://b.com",
          metadata: {
            fingerprint: "f2",
            goalVersion: "gvOLD",
            eventKey: "eOld",
            eventLabel: "Stale",
          },
        },
      ],
      "gv1",
    );
    expect(knownEvents).toEqual([{ key: "e1", label: "Event One" }]);
  });

  it("dedups repeated event keys and falls back label→key", () => {
    const { knownEvents } = reconstructKnownState(
      [
        {
          url: "https://a.com",
          metadata: { fingerprint: "f1", goalVersion: "gv1", eventKey: "e1" },
        },
        {
          url: "https://b.com",
          metadata: {
            fingerprint: "f2",
            goalVersion: "gv1",
            eventKey: "e1",
            eventLabel: "Later",
          },
        },
      ],
      "gv1",
    );
    expect(knownEvents).toEqual([{ key: "e1", label: "e1" }]);
  });

  it("orders events most-recently-seen first (resolver window holds active stories)", () => {
    const page = (url: string, eventKey: string, updated_at: string) => ({
      url,
      metadata: {
        fingerprint: "f",
        goalVersion: "gv1",
        eventKey,
        eventLabel: eventKey,
      },
      updated_at,
    });
    const { knownEvents } = reconstructKnownState(
      [
        page("https://a.com", "old-story", "2026-01-01T00:00:00Z"),
        page("https://b.com", "active-story", "2026-01-02T00:00:00Z"),
        // a newer article re-touches the old story — it should outrank active-story
        page("https://c.com", "old-story", "2026-06-01T00:00:00Z"),
      ],
      "gv1",
    );
    expect(knownEvents.map(e => e.key)).toEqual(["old-story", "active-story"]);
  });

  it("ignores pages with no usable metadata", () => {
    const { knownPages, knownEvents } = reconstructKnownState(
      [
        { url: "https://a.com", metadata: null },
        { url: "https://b.com", metadata: {} },
      ],
      "gv1",
    );
    expect(knownPages.size).toBe(0);
    expect(knownEvents).toEqual([]);
  });
});

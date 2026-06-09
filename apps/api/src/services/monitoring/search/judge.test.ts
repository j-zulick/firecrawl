import {
  freshnessFromDate,
  parseVerdict,
  verdictToDecision,
  type SearchVerdict,
} from "./judge";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";

describe("freshnessFromDate", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  it("returns null with no usable date (caller falls back to LLM)", () => {
    expect(freshnessFromDate(null, "24h", now)).toBeNull();
    expect(freshnessFromDate("not-a-date", "24h", now)).toBeNull();
  });
  it("fresh when within the window, stale when older", () => {
    expect(freshnessFromDate("2026-06-09T06:00:00Z", "24h", now)).toBe("fresh");
    expect(freshnessFromDate("2026-06-07T06:00:00Z", "24h", now)).toBe("stale");
  });
  it("respects the window size", () => {
    expect(freshnessFromDate("2026-06-09T10:00:00Z", "1h", now)).toBe("stale");
    expect(freshnessFromDate("2026-06-09T11:30:00Z", "1h", now)).toBe("fresh");
  });
  it("future-dated counts as fresh", () => {
    expect(freshnessFromDate("2026-06-10T00:00:00Z", "24h", now)).toBe("fresh");
  });
});

const v = (over: Partial<SearchVerdict>): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
  freshness: "fresh",
  sourceQuality: "authoritative",
  concept: "x",
  rationale: "x",
  ...over,
});

describe("verdictToDecision", () => {
  it("notifies on relevant + fresh + trusted + alert", () => {
    expect(verdictToDecision(v({}))).toBe("notify");
  });
  it("ignores when not relevant", () => {
    expect(verdictToDecision(v({ relevant: false }))).toBe("ignore");
  });
  it("ignores when judge says ignore", () => {
    expect(verdictToDecision(v({ alertAction: "ignore" }))).toBe("ignore");
  });
  it("watches when judge says watch", () => {
    expect(verdictToDecision(v({ alertAction: "watch" }))).toBe("watch");
  });
  it("downgrades stale to watch even if alert", () => {
    expect(verdictToDecision(v({ freshness: "stale" }))).toBe("watch");
    expect(verdictToDecision(v({ freshness: "unknown" }))).toBe("watch");
  });
  it("downgrades weak sources to watch", () => {
    expect(verdictToDecision(v({ sourceQuality: "unverified" }))).toBe("watch");
    expect(verdictToDecision(v({ sourceQuality: "unclear" }))).toBe("watch");
  });
});

describe("parseVerdict", () => {
  it("returns null for non-objects / missing relevant", () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict("x")).toBeNull();
    expect(parseVerdict({})).toBeNull();
  });
  it("coerces a valid verdict", () => {
    expect(
      parseVerdict({
        relevant: true,
        alertAction: "alert",
        freshness: "fresh",
        sourceQuality: "first-party",
        concept: "c",
        rationale: "r",
      }),
    ).toMatchObject({ relevant: true, alertAction: "alert", concept: "c" });
  });
  it("defaults unknown enum values safely", () => {
    const out = parseVerdict({ relevant: true, alertAction: "bogus" });
    expect(out?.alertAction).toBe("watch");
    expect(out?.freshness).toBe("unknown");
    expect(out?.sourceQuality).toBe("unclear");
  });
});

describe("dedupe", () => {
  it("canonicalizes (host/www/trailing slash/case)", () => {
    expect(canonicalizeUrl("https://www.Example.com/Path/")).toBe(
      canonicalizeUrl("https://example.com/path"),
    );
  });
  it("same title+snippet → same fingerprint (URL-independent)", () => {
    const a = stableSerpFingerprint({
      url: "https://a.com",
      title: "T",
      snippet: "S",
    });
    const b = stableSerpFingerprint({
      url: "https://b.com",
      title: "T",
      snippet: "S",
    });
    expect(a).toBe(b);
  });
  it("different snippet → different fingerprint", () => {
    const a = stableSerpFingerprint({
      url: "https://a.com",
      title: "T",
      snippet: "S1",
    });
    const b = stableSerpFingerprint({
      url: "https://a.com",
      title: "T",
      snippet: "S2",
    });
    expect(a).not.toBe(b);
  });
});

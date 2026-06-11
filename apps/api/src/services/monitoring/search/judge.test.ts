import {
  applyVerdictDefenses,
  contradictionFromRationale,
  parseVerdict,
  stripJudgeMetaClaims,
  verdictToDecision,
  type SearchVerdict,
} from "./judge";
import { canonicalizeUrl, stableSerpFingerprint } from "./dedupe";

const v = (over: Partial<SearchVerdict>): SearchVerdict => ({
  relevant: true,
  alertAction: "alert",
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
        concept: "c",
        rationale: "r",
      }),
    ).toMatchObject({ relevant: true, alertAction: "alert", concept: "c" });
  });
  it("defaults unknown enum values safely", () => {
    const out = parseVerdict({ relevant: true, alertAction: "bogus" });
    expect(out?.alertAction).toBe("watch");
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

describe("verdict defenses", () => {
  it("notify requires a non-empty concept (event dedup needs a label)", () => {
    expect(verdictToDecision(v({ concept: "" }))).toBe("watch");
    expect(verdictToDecision(v({ concept: "  " }))).toBe("watch");
  });

  it("detects evidence-absent contradictions as no", () => {
    expect(
      contradictionFromRationale("The page does not mention Firecrawl at all."),
    ).toBe("no");
    expect(
      contradictionFromRationale(
        "The monitored subject is not present on this page.",
      ),
    ).toBe("no");
    expect(
      contradictionFromRationale("This is only a related background piece."),
    ).toBe("no");
  });

  it("detects insufficient-evidence contradictions as unclear", () => {
    expect(
      contradictionFromRationale(
        "There is not enough evidence to confirm a launch.",
      ),
    ).toBe("unclear");
  });

  it("returns empty for a rationale that supports the verdict", () => {
    expect(
      contradictionFromRationale("Anthropic's own blog announces the release."),
    ).toBe("");
  });

  it("applyVerdictDefenses flips a self-contradicting alert to ignore", () => {
    const corrected = applyVerdictDefenses(
      v({ rationale: "The page does not mention the subject." }),
    );
    expect(corrected.relevant).toBe(false);
    expect(corrected.alertAction).toBe("ignore");
  });

  it("applyVerdictDefenses caps insufficient-evidence alerts at watch", () => {
    const corrected = applyVerdictDefenses(
      v({ rationale: "Not enough evidence to alert on this." }),
    );
    expect(corrected.alertAction).toBe("watch");
    expect(corrected.relevant).toBe(true);
  });

  it("strips meta-claims and field boilerplate, keeps page facts", () => {
    const stripped = stripJudgeMetaClaims(
      "Anthropic released Claude 5 today. This fits within the requested topic lanes. Source quality is first-party. Alert action: alert.",
    );
    expect(stripped).toContain("Anthropic released Claude 5 today.");
    expect(stripped).not.toMatch(/topic lanes/i);
    expect(stripped).not.toMatch(/Source quality/i);
    expect(stripped).not.toMatch(/Alert action/i);
  });
});

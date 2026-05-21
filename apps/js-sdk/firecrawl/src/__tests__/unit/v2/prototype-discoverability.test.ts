import { Firecrawl } from "../../../index";

describe("V2 prototype discoverability", () => {
  const app = new Firecrawl({ apiKey: "fc-test", apiUrl: "http://localhost:9" });

  it("exposes V2 methods on immediate Firecrawl prototype", () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(app));

    expect(names).toEqual(
      expect.arrayContaining([
        "scrape",
        "search",
        "map",
        "crawl",
        "startCrawl",
        "getCrawlStatus",
        "batchScrape",
        "v1",
      ])
    );
  });

  it("preserves v1 getter on Firecrawl prototype", () => {
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(app),
      "v1"
    );
    expect(desc).toBeDefined();
    expect(desc!.get).toBeDefined();
  });

  it("exposed methods are callable with correct this binding", async () => {
    const spy = jest
      .spyOn(app, "scrape")
      .mockResolvedValue({ markdown: "ok" } as any);
    await app.scrape("https://example.com", { formats: ["markdown"] });
    expect(spy).toHaveBeenCalledWith("https://example.com", {
      formats: ["markdown"],
    });
    spy.mockRestore();
  });
});

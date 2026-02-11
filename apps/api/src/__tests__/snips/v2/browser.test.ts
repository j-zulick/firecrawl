import { describeIf, HAS_FIRE_ENGINE, TEST_SELF_HOST } from "../lib";
import { scrapeTimeout, idmux, Identity, TEST_API_URL } from "./lib";
import request from "./lib";
import {
  BrowserCreateRequest,
  BrowserCreateResponse,
  BrowserExecuteRequest,
  BrowserExecuteResponse,
  BrowserDeleteRequest,
  BrowserDeleteResponse,
} from "../../../controllers/v2/browser";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "browser",
    concurrency: 10,
    credits: 100000,
  });
}, 10000);

// Browser feature requires fire-engine and sandbox — skip in self-hosted
describeIf(!TEST_SELF_HOST && HAS_FIRE_ENGINE)("Browser API", () => {
  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  async function browserCreateRaw(body: Partial<BrowserCreateRequest>) {
    return await request(TEST_API_URL)
      .post("/v2/browser")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(body);
  }

  async function browserExecuteRaw(body: BrowserExecuteRequest) {
    return await request(TEST_API_URL)
      .post("/v2/browser/execute")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(body);
  }

  async function browserDeleteRaw(body: BrowserDeleteRequest) {
    return await request(TEST_API_URL)
      .delete("/v2/browser")
      .set("Authorization", `Bearer ${identity.apiKey}`)
      .set("Content-Type", "application/json")
      .send(body);
  }

  // ---------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------

  it(
    "creates a browser session, executes code, then deletes it (happy path)",
    async () => {
      // 1. Create session
      const createRes = await browserCreateRaw({});
      expect(createRes.statusCode).toBe(200);
      expect(createRes.body.success).toBe(true);
      expect(typeof createRes.body.browserId).toBe("string");
      expect(typeof createRes.body.cdpUrl).toBe("string");

      const { browserId } = createRes.body as BrowserCreateResponse;

      // 2. Execute code — navigate to example.com and get the title
      const execRes = await browserExecuteRaw({
        browserId: browserId!,
        code: `
await page.goto("https://example.com")
print(await page.title())
`,
        language: "python",
      });

      expect(execRes.statusCode).toBe(200);
      expect(execRes.body.success).toBe(true);
      expect(typeof execRes.body.result).toBe("string");
      expect(execRes.body.result).toContain("Example Domain");

      // 3. Delete session
      const deleteRes = await browserDeleteRaw({
        browserId: browserId!,
      });
      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.body.success).toBe(true);
    },
    scrapeTimeout * 2,
  );

  it(
    "returns 404 when executing code on a non-existent session",
    async () => {
      const execRes = await browserExecuteRaw({
        browserId: "00000000-0000-7000-8000-000000000000",
        code: "print('hello')",
        language: "python",
      });

      expect(execRes.statusCode).toBe(404);
      expect(execRes.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it(
    "returns 404 when deleting a non-existent session",
    async () => {
      const deleteRes = await browserDeleteRaw({
        browserId: "00000000-0000-7000-8000-000000000000",
      });

      expect(deleteRes.statusCode).toBe(404);
      expect(deleteRes.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  it("rejects unauthenticated requests", async () => {
    const res = await request(TEST_API_URL)
      .post("/v2/browser")
      .set("Content-Type", "application/json")
      .send({});

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

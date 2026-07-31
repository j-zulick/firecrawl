import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logRequest: vi.fn(),
  logSearch: vi.fn(),
  logResearchEndpoint: vi.fn(),
  fetchResearchUpstream: vi.fn(),
}));

vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.logRequest,
  logSearch: mocks.logSearch,
  logResearchEndpoint: mocks.logResearchEndpoint,
}));

vi.mock("../../../lib/research-upstream", () => ({
  fetchResearchUpstream: mocks.fetchResearchUpstream,
}));

vi.mock("../../../services/billing/credit_billing", () => ({
  billTeam: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { createDeveloperRouter } from "../research-proxy";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";

/** Pulls the GET handler out of the router's stack for either mount shape. */
function developerHandler(options: { root?: boolean } = {}) {
  const router: any = createDeveloperRouter(options);
  const path = options.root ? "/" : "/search";
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.get,
  );
  return layer.route.stack[0].handle;
}

function makeReq(flags: Record<string, unknown> | null) {
  return {
    method: "GET",
    query: { query: "http client" },
    body: {},
    headers: {},
    auth: { team_id: TEAM_ID },
    acuc: flags === null ? undefined : { api_key_id: 7, flags },
  } as any;
}

function makeRes() {
  const res: any = { status: vi.fn(), json: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logRequest.mockResolvedValue(undefined);
  mocks.logResearchEndpoint.mockResolvedValue(undefined);
});

describe.each([
  { name: "/v2/developer/search", options: {} },
  { name: "/v2/search/developer (root alias)", options: { root: true } },
])("developer endpoint beta gate on $name", ({ options }) => {
  it("403s a team without developerBeta and never calls upstream", async () => {
    const res = makeRes();
    await developerHandler(options)(makeReq({ developerBeta: false }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).not.toHaveBeenCalled();
    expect(mocks.logRequest).not.toHaveBeenCalled();
  });

  it("403s a keyless caller (no acuc at all)", async () => {
    const res = makeRes();
    await developerHandler(options)(makeReq(null), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.fetchResearchUpstream).not.toHaveBeenCalled();
  });

  it("does not 403 a team with developerBeta", async () => {
    mocks.fetchResearchUpstream.mockResolvedValue(null); // 404 path, past the gate
    const res = makeRes();
    await developerHandler(options)(makeReq({ developerBeta: true }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

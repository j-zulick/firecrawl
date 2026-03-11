import type { Response } from "express";
import type { RequestWithAuth, AgentRequest, AgentResponse } from "../types";
import { supabase_service } from "../../../services/supabase";

// --- mocks ----------------------------------------------------------------

jest.mock("uuid", () => ({
  v7: jest.fn().mockReturnValue("00000000-0000-0000-0000-000000000000"),
}));

jest.mock("../../../lib/logger", () => ({
  logger: {
    child: jest.fn().mockReturnValue({ error: jest.fn(), info: jest.fn() }),
    info: jest.fn(),
  },
}));

jest.mock("../../../services/logging/log_job", () => ({
  logRequest: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../services/supabase", () => ({
  supabase_service: { rpc: jest.fn() },
}));

jest.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    EXTRACT_V3_BETA_URL: "http://extract-v3",
    AGENT_INTEROP_SECRET: "test-secret",
  },
}));

// Import after mocks are set up
import { agentController } from "../agent";

// Capture the fetch calls to inspect the body sent to extract-v3
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockRpc = supabase_service.rpc as jest.Mock;

// --- helpers --------------------------------------------------------------

function buildReq(
  body: Partial<AgentRequest> & { prompt: string },
): RequestWithAuth<{}, AgentResponse, AgentRequest> {
  return {
    body: { model: "spark-1-pro", ...body } as AgentRequest,
    auth: { team_id: "team-123" },
    acuc: { api_key: "fc-key", api_key_id: "key-id", flags: {} },
  } as any;
}

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

function extractPassthroughBody(): Record<string, unknown> {
  const call = mockFetch.mock.calls[0];
  return JSON.parse(call[1].body);
}

// --- tests ----------------------------------------------------------------

describe("agentController – maxCredits paid gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: supabase says a free request was consumed
    mockRpc.mockResolvedValue({ data: [{ consumed: true }], error: null });
    // Default: extract-v3 returns 200
    mockFetch.mockResolvedValue({ status: 200 });
  });

  it("passes isFreeRequest=true when maxCredits is not set and free request consumed", async () => {
    const res = buildRes();
    await agentController(buildReq({ prompt: "test" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = extractPassthroughBody();
    expect(body.isFreeRequest).toBe(true);
  });

  it("passes isFreeRequest=true when maxCredits <= 2500 and free request consumed", async () => {
    const res = buildRes();
    await agentController(buildReq({ prompt: "test", maxCredits: 2500 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = extractPassthroughBody();
    expect(body.isFreeRequest).toBe(true);
    expect(body.maxCredits).toBe(2500);
  });

  it("forces isFreeRequest=false when maxCredits > 2500", async () => {
    const res = buildRes();
    await agentController(buildReq({ prompt: "test", maxCredits: 3000 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = extractPassthroughBody();
    expect(body.isFreeRequest).toBe(false);
    expect(body.maxCredits).toBe(3000);
  });

  it("forces isFreeRequest=false when maxCredits is just above 2500", async () => {
    const res = buildRes();
    await agentController(buildReq({ prompt: "test", maxCredits: 2501 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = extractPassthroughBody();
    expect(body.isFreeRequest).toBe(false);
  });

  it("keeps isFreeRequest=false when no free request available, regardless of maxCredits", async () => {
    // Supabase says no free request consumed
    mockRpc.mockResolvedValue({ data: [{ consumed: false }], error: null });

    const res = buildRes();
    await agentController(buildReq({ prompt: "test", maxCredits: 1000 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = extractPassthroughBody();
    expect(body.isFreeRequest).toBe(false);
  });
});

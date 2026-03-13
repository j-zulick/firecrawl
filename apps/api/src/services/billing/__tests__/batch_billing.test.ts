import { jest } from "@jest/globals";

const captureException = jest.fn();
jest.mock("@sentry/node", () => ({
  captureException,
}));

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => logger),
};
jest.mock("../../../lib/logger", () => ({
  logger,
}));

const withAuth = jest.fn((fn: any) => fn);
jest.mock("../../../lib/withAuth", () => ({
  withAuth,
}));

const reserveCredits = jest.fn<(args: any) => Promise<boolean>>();
const finalizeCreditsLock = jest.fn<(args: any) => Promise<void>>();
jest.mock("../../autumn/autumn.service", () => ({
  autumnService: {
    reserveCredits,
    finalizeCreditsLock,
  },
}));

const rpc = jest.fn<(name: string, args: any) => Promise<any>>();
jest.mock("../../supabase", () => ({
  supabase_service: {
    rpc,
  },
}));

const setCachedACUC = jest.fn();
const setCachedACUCTeam = jest.fn();
jest.mock("../../../controllers/auth", () => ({
  setCachedACUC,
  setCachedACUCTeam,
}));

let queue: string[] = [];
const billedTeams = new Set<string>();
const locks = new Map<string, string>();
const redis = {
  set: jest.fn(
    async (
      key: string,
      value: string,
      mode: string,
      timeout: number,
      nx: string,
    ) => {
      if (
        key !== "billing_batch_lock" ||
        value !== "1" ||
        mode !== "PX" ||
        timeout !== 30000 ||
        nx !== "NX"
      ) {
        throw new Error("unexpected redis.set args");
      }
      if (locks.has(key)) return null;
      locks.set(key, value);
      return "OK";
    },
  ),
  del: jest.fn(async (key: string) => {
    if (key !== "billing_batch_lock") {
      throw new Error("unexpected redis.del key");
    }
    return locks.delete(key) ? 1 : 0;
  }),
  lpop: jest.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.lpop key");
    }
    return queue.shift() ?? null;
  }),
  llen: jest.fn(async (key: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.llen key");
    }
    return queue.length;
  }),
  rpush: jest.fn(async (key: string, value: string) => {
    if (key !== "billing_batch") {
      throw new Error("unexpected redis.rpush key");
    }
    queue.push(value);
    return queue.length;
  }),
  sadd: jest.fn(async (key: string, teamId: string) => {
    if (key !== "billed_teams") {
      throw new Error("unexpected redis.sadd key");
    }
    billedTeams.add(teamId);
    return 1;
  }),
};
jest.mock("../../queue-service", () => ({
  getRedisConnection: () => redis,
}));

import { processBillingBatch } from "../batch_billing";

function makeOp(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    team_id: "team-1",
    subscription_id: "sub-1",
    credits: 10,
    billing: { endpoint: "extract" },
    is_extract: false,
    timestamp: "2026-03-13T00:00:00.000Z",
    api_key_id: 123,
    autumnLockId: null,
    autumnProperties: {
      source: "billTeam",
      endpoint: "extract",
      apiKeyId: 123,
    },
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  queue = [];
  billedTeams.clear();
  locks.clear();
  reserveCredits.mockResolvedValue(true);
  finalizeCreditsLock.mockResolvedValue(undefined);
  rpc.mockResolvedValue({ data: [], error: null });
});

describe("processBillingBatch", () => {
  it("awaits lock confirmation before tracking unlocked credits", async () => {
    const finalize = deferred<void>();
    finalizeCreditsLock.mockReturnValueOnce(finalize.promise);
    queue = [
      makeOp({ credits: 7, autumnLockId: "lock-1" }),
      makeOp({ credits: 3, autumnLockId: null }),
    ];

    const run = processBillingBatch();
    await new Promise(resolve => setImmediate(resolve));

    expect(finalizeCreditsLock).toHaveBeenCalledWith({
      lockId: "lock-1",
      action: "confirm",
      properties: expect.objectContaining({
        source: "billTeam",
        apiKeyId: 123,
        subscriptionId: "sub-1",
        finalizeSource: "processBillingBatch",
      }),
    });
    expect(reserveCredits).not.toHaveBeenCalled();

    finalize.resolve();
    await run;

    expect(reserveCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 3,
      properties: expect.objectContaining({
        source: "processBillingBatch",
        apiKeyId: 123,
        subscriptionId: "sub-1",
      }),
    });
  });

  it("releases Autumn locks when billing returns success false", async () => {
    queue = [makeOp({ autumnLockId: "lock-1" })];
    rpc.mockResolvedValueOnce({ data: null, error: new Error("db failed") });

    await processBillingBatch();

    expect(finalizeCreditsLock).toHaveBeenCalledWith({
      lockId: "lock-1",
      action: "release",
      properties: expect.objectContaining({
        source: "billTeam",
        finalizeSource: "processBillingBatch_failure",
      }),
    });
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it("releases Autumn locks when billing throws", async () => {
    queue = [makeOp({ autumnLockId: "lock-1" })];
    rpc.mockRejectedValueOnce(new Error("rpc exploded"));

    await processBillingBatch();

    expect(finalizeCreditsLock).toHaveBeenCalledWith({
      lockId: "lock-1",
      action: "release",
      properties: expect.objectContaining({
        source: "billTeam",
        finalizeSource: "processBillingBatch_exception",
      }),
    });
    expect(captureException).toHaveBeenCalled();
  });

  it("treats undefined autumnLockId as unlocked for legacy queued ops", async () => {
    queue = [makeOp({ autumnLockId: undefined })];

    await processBillingBatch();

    expect(finalizeCreditsLock).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledWith({
      teamId: "team-1",
      value: 10,
      properties: expect.objectContaining({
        source: "processBillingBatch",
      }),
    });
  });

  it("survives unexpected synchronous finalizeAutumnLocks failures", async () => {
    queue = [makeOp({ autumnLockId: "lock-1" })];
    finalizeCreditsLock.mockImplementationOnce(() => {
      throw new Error("sync finalize failure");
    });

    await processBillingBatch();

    expect(logger.warn).toHaveBeenCalledWith(
      "Autumn finalizeAutumnLocks failed unexpectedly",
      expect.objectContaining({ team_id: "team-1", action: "confirm" }),
    );
  });
});

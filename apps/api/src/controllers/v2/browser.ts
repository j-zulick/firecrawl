import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  insertBrowserSession,
  getBrowserSession,
  listBrowserSessions,
  updateBrowserSessionActivity,
  updateBrowserSessionStatus,
} from "../../lib/browser-sessions";
import { RequestWithAuth } from "./types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttl: z.number().min(30).max(3600).default(300),
  activityTtl: z.number().min(10).max(3600).optional(),
  streamWebView: z.boolean().default(true),
});

type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

interface BrowserCreateResponse {
  success: boolean;
  id?: string;
  cdpUrl?: string;
  liveViewUrl?: string;
  expiresAt?: string;
  error?: string;
}

const browserExecuteRequestSchema = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "node", "bash"]).default("node"),
  timeout: z.number().min(1).max(300).default(30),
});

type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

interface BrowserExecuteResponse {
  success: boolean;
  stdout?: string;
  result?: string;
  stderr?: string;
  exitCode?: number;
  killed?: boolean;
  error?: string;
}

interface BrowserDeleteResponse {
  success: boolean;
  sessionDurationMs?: number;
  error?: string;
}

interface BrowserListResponse {
  success: boolean;
  sessions?: Array<{
    id: string;
    status: string;
    cdpUrl: string;
    liveViewUrl: string;
    streamWebView: boolean;
    createdAt: string;
    lastActivity: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build headers for authenticating against the browser service.
 */
function browserServiceHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extra ?? {}),
  };
  if (config.BROWSER_SERVICE_API_KEY) {
    headers["Authorization"] = `Bearer ${config.BROWSER_SERVICE_API_KEY}`;
  }
  return headers;
}

/**
 * Call the browser service and return parsed JSON.
 * Throws on non-2xx responses.
 */
async function browserServiceRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.BROWSER_SERVICE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: browserServiceHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Browser service ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Browser service response types
// ---------------------------------------------------------------------------

interface BrowserServiceCreateResponse {
  sessionId: string;
  cdpUrl: string;
  viewUrl: string;
  expiresAt: string;
}

interface BrowserServiceExecResponse {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

interface BrowserServiceDeleteResponse {
  ok: boolean;
  sessionDurationMs: number;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

export async function browserCreateController(
  req: RequestWithAuth<{}, BrowserCreateResponse, BrowserCreateRequest>,
  res: Response<BrowserCreateResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  const sessionId = uuidv7();
  const logger = _logger.child({
    sessionId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserCreateController",
  });

  req.body = browserCreateRequestSchema.parse(req.body);

  const { ttl, activityTtl, streamWebView } = req.body;

  if (!config.BROWSER_SERVICE_URL) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (BROWSER_SERVICE_URL is missing).",
    });
  }

  logger.info("Creating browser session", { ttl, activityTtl });

  // 1. Create a browser session via the browser service
  let svcResponse: BrowserServiceCreateResponse;
  try {
    svcResponse = await browserServiceRequest<BrowserServiceCreateResponse>(
      "POST",
      "/browsers",
      {
        ttl,
        ...(activityTtl !== undefined ? { activityTtl } : {}),
      },
    );
  } catch (err) {
    logger.error("Failed to create browser session via browser service", {
      error: err,
    });
    return res.status(502).json({
      success: false,
      error: "Failed to create browser session.",
    });
  }

  // 2. Persist session in Supabase
  try {
    await insertBrowserSession({
      id: sessionId,
      team_id: req.auth.team_id,
      browser_id: svcResponse.sessionId,
      workspace_id: "",
      context_id: "",
      cdp_url: svcResponse.cdpUrl,
      cdp_path: svcResponse.viewUrl, // repurposed: stores view URL
      stream_web_view: streamWebView,
      status: "active",
      ttl_total: ttl,
      ttl_without_activity: activityTtl ?? null,
    });
  } catch (err) {
    // If we can't persist, tear down the browser session
    logger.error("Failed to persist browser session, cleaning up", {
      error: err,
    });
    await browserServiceRequest(
      "DELETE",
      `/browsers/${svcResponse.sessionId}`,
    ).catch(() => {});
    return res.status(500).json({
      success: false,
      error: "Failed to persist browser session.",
    });
  }

  logger.info("Browser session created", {
    sessionId,
    browserId: svcResponse.sessionId,
  });

  return res.status(200).json({
    success: true,
    id: sessionId,
    cdpUrl: svcResponse.cdpUrl,
    liveViewUrl: svcResponse.viewUrl,
    expiresAt: svcResponse.expiresAt,
  });
}

export async function browserExecuteController(
  req: RequestWithAuth<
    { sessionId: string },
    BrowserExecuteResponse,
    BrowserExecuteRequest
  >,
  res: Response<BrowserExecuteResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  req.body = browserExecuteRequestSchema.parse(req.body);

  const id = req.params.sessionId;
  const { code, language, timeout } = req.body;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserExecuteController",
  });

  // Look up session from Supabase
  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  if (session.status === "destroyed") {
    return res.status(410).json({
      success: false,
      error: "Browser session has been destroyed.",
    });
  }

  // Update activity timestamp (fire-and-forget)
  updateBrowserSessionActivity(id).catch(() => {});

  logger.info("Executing code in browser session", { language, timeout });

  // Execute code via the browser service
  let execResult: BrowserServiceExecResponse;
  try {
    execResult = await browserServiceRequest<BrowserServiceExecResponse>(
      "POST",
      `/browsers/${session.browser_id}/exec`,
      { code, language, timeout },
    );
  } catch (err) {
    logger.error("Failed to execute code via browser service", { error: err });
    return res.status(502).json({
      success: false,
      error: "Failed to execute code in browser session.",
    });
  }

  logger.debug("Execution result", {
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    stdoutLength: execResult.stdout?.length,
    stderrLength: execResult.stderr?.length,
  });

  const hasError = execResult.exitCode !== 0 || execResult.killed;

  return res.status(200).json({
    success: true,
    stdout: execResult.stdout,
    result: execResult.result,
    stderr: execResult.stderr,
    exitCode: execResult.exitCode,
    killed: execResult.killed,
    ...(hasError
      ? { error: execResult.stderr || "Execution failed" }
      : {}),
  });
}

export async function browserDeleteController(
  req: RequestWithAuth<{ sessionId: string }, BrowserDeleteResponse>,
  res: Response<BrowserDeleteResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  const id = req.params.sessionId;

  const logger = _logger.child({
    sessionId: id,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserDeleteController",
  });

  const session = await getBrowserSession(id);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.team_id !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger.info("Deleting browser session");

  // Release the browser session via the browser service
  let sessionDurationMs: number | undefined;
  try {
    const deleteResult =
      await browserServiceRequest<BrowserServiceDeleteResponse>(
        "DELETE",
        `/browsers/${session.browser_id}`,
      );
    sessionDurationMs = deleteResult?.sessionDurationMs;
  } catch (err) {
    logger.warn("Failed to delete browser session via browser service", {
      error: err,
    });
  }

  // Mark destroyed in Supabase
  await updateBrowserSessionStatus(session.id, "destroyed");

  logger.info("Browser session destroyed", { sessionDurationMs });

  return res.status(200).json({
    success: true,
    sessionDurationMs,
  });
}

export async function browserListController(
  req: RequestWithAuth<{}, BrowserListResponse>,
  res: Response<BrowserListResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  const logger = _logger.child({
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserListController",
  });

  logger.info("Listing browser sessions");

  const statusFilter = (req.query as Record<string, string>).status as
    | "active"
    | "destroyed"
    | undefined;

  const rows = await listBrowserSessions(req.auth.team_id, {
    status: statusFilter,
  });

  return res.status(200).json({
    success: true,
    sessions: rows.map((r) => ({
      id: r.id,
      status: r.status,
      cdpUrl: r.cdp_url,
      liveViewUrl: r.cdp_path, // cdp_path stores the view URL
      streamWebView: r.stream_web_view,
      createdAt: r.created_at,
      lastActivity: r.updated_at,
    })),
  });
}

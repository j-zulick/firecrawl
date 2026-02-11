import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import {
  createSandboxClient,
  Workspace,
  CodeContext,
  Execution,
} from "../../lib/sandbox-client";
import { RequestWithAuth } from "./types";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const browserCreateRequestSchema = z.object({
  ttlTotal: z.number().min(30).max(3600).default(300),
  ttlWithoutActivity: z.number().min(10).max(3600).optional(),
  streamWebView: z.boolean().default(false),
});

export type BrowserCreateRequest = z.infer<typeof browserCreateRequestSchema>;

export interface BrowserCreateResponse {
  success: boolean;
  browserId?: string;
  cdpUrl?: string;
  error?: string;
}

const browserExecuteRequestSchema = z.object({
  browserId: z.string(),
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "js"]).default("python"),
});

export type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>;

export interface BrowserExecuteResponse {
  success: boolean;
  result?: string;
  error?: string;
}

const browserDeleteRequestSchema = z.object({
  browserId: z.string(),
});

export type BrowserDeleteRequest = z.infer<typeof browserDeleteRequestSchema>;

export interface BrowserDeleteResponse {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

interface BrowserSession {
  browserId: string;
  teamId: string;
  workspace: Workspace;
  context: CodeContext;
  cdpUrl: string;
  cdpPath: string;
  streamWebView: boolean;
  createdAt: number;
  lastActivity: number;
  ttlTotal: number;
  ttlWithoutActivity?: number;
  destroyed: boolean;
}

const sessions = new Map<string, BrowserSession>();

/** Periodic cleanup of expired sessions */
// setInterval(() => {
//   const now = Date.now();
//   for (const [id, session] of sessions) {
//     if (session.destroyed) {
//       sessions.delete(id);
//       continue;
//     }
//     const totalExpired = now - session.createdAt > session.ttlTotal * 1000;
//     const activityExpired =
//       session.ttlWithoutActivity !== undefined &&
//       now - session.lastActivity > session.ttlWithoutActivity * 1000;
//     if (totalExpired || activityExpired) {
//       destroySession(session).catch(() => {});
//     }
//   }
// }, 15_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSandboxClient() {
  return createSandboxClient({
    baseUrl: config.SANDBOX_API_URL!,
    podUrlTemplate: config.SANDBOX_POD_URL_TEMPLATE,
  });
}

/**
 * Extract the printable output from a sandbox Execution result.
 */
function executionToString(exec: Execution): string {
  const parts: string[] = [];
  return exec.text ?? "";

  // // Collect stdout log lines
  // if (exec.logs.stdout.length > 0) {
  //   parts.push(exec.logs.stdout.join("\n"));
  // }

  // // Collect stderr log lines
  // if (exec.logs.stderr.length > 0) {
  //   parts.push(exec.logs.stderr.join("\n"));
  // }

  // // Collect result text
  // if (exec.text) {
  //   parts.push(exec.text);
  // }

  // for (const r of exec.results) {
  //   if (r.text) {
  //     parts.push(r.text);
  //   }
  // }

  // // Collect error info
  // if (exec.error) {
  //   parts.push(
  //     `${exec.error.name}: ${exec.error.value}${exec.error.traceback ? "\n" + exec.error.traceback : ""}`,
  //   );
  // }

  // return parts.join("\n");
}

async function destroySession(session: BrowserSession) {
  if (session.destroyed) return;
  session.destroyed = true;

  const logger = _logger.child({
    browserId: session.browserId,
    module: "browser",
  });

  try {
    // Tell the sandbox to close the browser
    await session.context.runCode("await browser.close()").catch(() => {}); // best-effort

    // Tear down the CDP session on fire-engine
    if (config.FIRE_ENGINE_BETA_URL) {
      await fetch(
        `${config.FIRE_ENGINE_BETA_URL}/cdp-session/${session.browserId}`,
        { method: "DELETE" },
      ).catch(() => {});
    }

    // Destroy the sandbox workspace
    await session.workspace.destroy().catch(() => {});

    logger.info("Browser session destroyed");
  } catch (err) {
    logger.warn("Error while destroying browser session", { error: err });
  } finally {
    sessions.delete(session.browserId);
  }
}

function getSession(browserId: string): BrowserSession | undefined {
  return sessions.get(browserId);
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

  const browserId = uuidv7();
  const logger = _logger.child({
    browserId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserCreateController",
  });

  req.body = browserCreateRequestSchema.parse(req.body);

  const { ttlTotal, ttlWithoutActivity, streamWebView } = req.body;

  if (!config.FIRE_ENGINE_BETA_URL) {
    return res.status(503).json({
      success: false,
      error:
        "Browser feature is not configured (FIRE_ENGINE_BETA_URL is missing).",
    });
  }

  if (!config.SANDBOX_API_URL) {
    return res.status(503).json({
      success: false,
      error: "Browser feature is not configured (SANDBOX_API_URL is missing).",
    });
  }

  logger.info("Creating browser session", {
    ttlTotal,
    ttlWithoutActivity,
    streamWebView,
  });

  // 1. Acquire a CDP session from fire-engine
  const cdpRes = await fetch(`${config.FIRE_ENGINE_BETA_URL}/cdp-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      country: "us",
      mobileProxy: false,
      useProxy: true,
    }),
  });

  if (!cdpRes.ok) {
    const text = await cdpRes.text();
    logger.error("Failed to create CDP session", {
      status: cdpRes.status,
      text,
    });
    return res.status(502).json({
      success: false,
      error: "Failed to create browser CDP session.",
    });
  }

  const { browserId: feBrowserId, cdpPath } = (await cdpRes.json()) as {
    browserId: string;
    cdpPath: string;
  };

  // 2. Create a sandbox workspace and context
  const client = getSandboxClient();
  const workspace = await client.createWorkspace({ ttlSeconds: ttlTotal });
  const ctx = await workspace.createContext();

  // 3. Bridge CDP into the sandbox
  await ctx.enableBrowser(cdpPath);

  // 4. Initialize Playwright inside the sandbox
  // TODO: fix - setup session reuse for context and page
  const initExec = await ctx.runCode(`
from playwright.async_api import async_playwright

__pw__ = await async_playwright().start()
browser = await __pw__.chromium.connect_over_cdp("ws://127.0.0.1:9222")
context = await browser.new_context()
page = await context.new_page()
`);

  if (initExec.error) {
    // Cleanup on failure
    await workspace.destroy().catch(() => {});
    if (config.FIRE_ENGINE_BETA_URL) {
      await fetch(`${config.FIRE_ENGINE_BETA_URL}/cdp-session/${feBrowserId}`, {
        method: "DELETE",
      }).catch(() => {});
    }

    return res.status(502).json({
      success: false,
      error: `Failed to initialize browser: ${initExec.error.name}: ${initExec.error.value}`,
    });
  }

  // Build the user-facing CDP URL
  const cdpUrl = `${config.CDP_PROXY_URL}${cdpPath}`;

  // 5. Store the session
  const session: BrowserSession = {
    browserId: feBrowserId,
    teamId: req.auth.team_id,
    workspace,
    context: ctx,
    cdpUrl,
    cdpPath,
    streamWebView,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ttlTotal,
    ttlWithoutActivity,
    destroyed: false,
  };

  sessions.set(feBrowserId, session);

  logger.info("Browser session created", {
    browserId: feBrowserId,
    cdpUrl,
  });

  return res.status(200).json({
    success: true,
    browserId: feBrowserId,
    cdpUrl,
  });
}

export async function browserExecuteController(
  req: RequestWithAuth<{}, BrowserExecuteResponse, BrowserExecuteRequest>,
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

  const { browserId, code, language } = req.body;

  const logger = _logger.child({
    browserId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserExecuteController",
  });

  const session = sessions.get(browserId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.teamId !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  if (session.destroyed) {
    return res.status(410).json({
      success: false,
      error: "Browser session has been destroyed.",
    });
  }

  session.lastActivity = Date.now();

  logger.info("Executing code in browser session", { language });

  // The sandbox currently only accepts Python via runCode.
  // For JS, we could wrap it differently in the future.
  console.log(`[browser-execute] Running code for session ${browserId}:`, code);
  const exec = await session.context.runCode(code);

  const output = executionToString(exec);

  console.log(
    `[browser-execute] Execution result for session ${browserId}:`,
    JSON.stringify(
      {
        text: exec.text,
        results: exec.results,
        logs: exec.logs,
        error: exec.error,
        outputLength: output.length,
      },
      null,
      2,
    ),
  );

  if (exec.error) {
    return res.status(200).json({
      success: true,
      result: output,
      error: `${exec.error.name}: ${exec.error.value}`,
    });
  }

  return res.status(200).json({
    success: true,
    result: output,
  });
}

export async function browserDeleteController(
  req: RequestWithAuth<{}, BrowserDeleteResponse, BrowserDeleteRequest>,
  res: Response<BrowserDeleteResponse>,
) {
  if (!req.acuc?.flags?.browserBeta) {
    return res.status(403).json({
      success: false,
      error:
        "Browser is currently in beta. Please contact support@firecrawl.com to request access.",
    });
  }

  req.body = browserDeleteRequestSchema.parse(req.body);

  const { browserId } = req.body;

  const logger = _logger.child({
    browserId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "browserDeleteController",
  });

  const session = sessions.get(browserId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: "Browser session not found.",
    });
  }

  if (session.teamId !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "Forbidden.",
    });
  }

  logger.info("Deleting browser session");

  await destroySession(session);

  return res.status(200).json({
    success: true,
  });
}

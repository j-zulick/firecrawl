import crypto from "crypto";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import { redisEvictConnection } from "../../redis";
import { exchangeOAuthCode } from "./client";
import { encryptSlackToken } from "./crypto";
import { sanitizeRedirectPath } from "./redirect";
import { upsertSlackInstallation } from "./store";
import type { SlackInstallationRow } from "./types";

const logger = _logger.child({ module: "slack-oauth" });

const STATE_TTL_SECONDS = 60 * 10; // 10 minutes to complete the flow
const STATE_PREFIX = "slack-oauth-state:";

const AUTHORIZE_ENDPOINT = "https://slack.com/oauth/v2/authorize";

type SlackOAuthStatePayload = {
  teamId: string;
  redirectPath: string;
};

export function isSlackConfigured(): boolean {
  return Boolean(
    config.SLACK_CLIENT_ID &&
      config.SLACK_CLIENT_SECRET &&
      config.SLACK_OAUTH_REDIRECT_URL,
  );
}

// Creates a signed-ish random state, stashes the team mapping in Redis, and
// returns the Slack authorize URL the browser should be sent to. State lives in
// Redis (not a signed cookie) because the callback lands on the API, which may
// be a different host than the dashboard that started the flow.
export async function createAuthorizeUrl(params: {
  teamId: string;
  redirectPath?: string;
}): Promise<{ url: string; state: string }> {
  if (!isSlackConfigured()) {
    throw new Error("slack_not_configured");
  }

  const state = crypto.randomBytes(24).toString("hex");
  const payload: SlackOAuthStatePayload = {
    teamId: params.teamId,
    redirectPath: sanitizeRedirectPath(params.redirectPath),
  };
  await redisEvictConnection.set(
    `${STATE_PREFIX}${state}`,
    JSON.stringify(payload),
    "EX",
    STATE_TTL_SECONDS,
  );

  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", config.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", config.SLACK_OAUTH_SCOPES);
  url.searchParams.set("redirect_uri", config.SLACK_OAUTH_REDIRECT_URL!);
  url.searchParams.set("state", state);

  return { url: url.toString(), state };
}

async function consumeState(
  state: string,
): Promise<SlackOAuthStatePayload | null> {
  const key = `${STATE_PREFIX}${state}`;
  const raw = await redisEvictConnection.get(key);
  if (!raw) return null;
  // One-time use.
  await redisEvictConnection.del(key);
  try {
    const parsed = JSON.parse(raw) as SlackOAuthStatePayload;
    if (!parsed?.teamId) return null;
    return {
      teamId: parsed.teamId,
      redirectPath: sanitizeRedirectPath(parsed.redirectPath),
    };
  } catch {
    return null;
  }
}

type SlackOAuthCallbackResult =
  | {
      ok: true;
      teamId: string;
      redirectPath: string;
      installation: SlackInstallationRow;
    }
  | {
      ok: false;
      error: string;
      redirectPath: string;
    };

// Handles the Slack redirect: validates state, exchanges the code, encrypts the
// bot token, and upserts the installation for the team.
export async function handleOAuthCallback(params: {
  code: string;
  state: string;
}): Promise<SlackOAuthCallbackResult> {
  const statePayload = await consumeState(params.state);
  if (!statePayload) {
    logger.warn("Slack OAuth callback with invalid/expired state");
    return { ok: false, error: "invalid_state", redirectPath: "/app/monitoring" };
  }

  const result = await exchangeOAuthCode({
    code: params.code,
    redirectUri: config.SLACK_OAUTH_REDIRECT_URL!,
  });

  if (!result.ok || !result.access_token || !result.team?.id) {
    logger.warn("Slack OAuth exchange failed", { error: result.error });
    return {
      ok: false,
      error: result.error ?? "oauth_exchange_failed",
      redirectPath: statePayload.redirectPath,
    };
  }

  try {
    const installation = await upsertSlackInstallation({
      teamId: statePayload.teamId,
      slackTeamId: result.team.id,
      slackTeamName: result.team.name ?? null,
      slackEnterpriseId: result.enterprise?.id ?? null,
      botUserId: result.bot_user_id ?? null,
      botToken: encryptSlackToken(result.access_token),
      scope: result.scope ?? null,
      authedUserId: result.authed_user?.id ?? null,
      appId: result.app_id ?? null,
      incomingWebhook: result.incoming_webhook ?? null,
    });

    logger.info("Slack installation stored", {
      teamId: statePayload.teamId,
      slackTeamId: result.team.id,
    });

    return {
      ok: true,
      teamId: statePayload.teamId,
      redirectPath: statePayload.redirectPath,
      installation,
    };
  } catch (error) {
    logger.error("Failed to persist Slack installation", { error });
    return {
      ok: false,
      error: "persist_failed",
      redirectPath: statePayload.redirectPath,
    };
  }
}

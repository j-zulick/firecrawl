import { config } from "../../config";
import { logger } from "../../lib/logger";
import type { TrackParams } from "./types";

// firebill's own internal budget (durable write + forward attempt) is up to
// ~3.5s worst case, so this is deliberately looser than the 2s timeout on the
// direct Autumn client.
const FIREBILL_TIMEOUT_MS = 5000;

// FIREBILL_ORG_IDS is decoded once at startup by the config schema; the Set is
// built lazily on first use and cached, keyed on the decoded array reference.
let allowlistCache: { source: string[] | undefined; ids: Set<string> } | null =
  null;

function firebillOrgIds(): Set<string> {
  const source = config.FIREBILL_ORG_IDS;
  if (!allowlistCache || allowlistCache.source !== source) {
    allowlistCache = {
      source,
      ids: new Set(
        (source ?? []).map(id => id.trim()).filter(id => id.length > 0),
      ),
    };
  }
  return allowlistCache.ids;
}

/**
 * Whether usage tracking for this org should be routed through firebill
 * instead of directly to Autumn. Requires firebill to be fully configured AND
 * the org to be on the rollout allowlist.
 */
export function shouldRouteToFirebill(orgId: string): boolean {
  if (!config.FIREBILL_URL || !config.FIREBILL_SECRET) return false;
  return firebillOrgIds().has(orgId);
}

/**
 * Sends a usage event to firebill, which records it durably in Postgres and
 * forwards it to Autumn (replaying failed deliveries instead of losing them).
 *
 * A negative value is a refund (refundCredits negates before calling track);
 * firebill's /v1/refund endpoint expects the POSITIVE amount and negates it
 * itself, so the absolute value is sent either way.
 *
 * Returns true when firebill accepted the event, mirroring the boolean
 * contract of the direct Autumn track path. A `false` here means "not billed
 * yet" — firebill keeps retrying delivery on its side.
 */
export async function firebillTrack({
  customerId,
  entityId,
  featureId,
  value,
  properties,
  idempotencyKey,
}: TrackParams): Promise<boolean> {
  const path = value < 0 ? "/v1/refund" : "/v1/track";
  // Plain concatenation rather than new URL(path, base): a leading-slash path
  // would drop any base-path prefix (e.g. a reverse proxy at /firebill).
  const url = `${config.FIREBILL_URL!.replace(/\/+$/, "")}${path}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.FIREBILL_SECRET}`,
        "content-type": "application/json",
      },
      // No overage flag needed: firebill itself pins Autumn's
      // overage_behavior to "overflow" on every upstream call, matching the
      // direct-Autumn path below.
      body: JSON.stringify({
        customer_id: customerId,
        entity_id: entityId,
        feature_id: featureId,
        value: Math.abs(value),
        properties,
        // Stable per-charge key: firebill makes it the intent row's primary
        // key, so a caller retry (or a requeued job re-billing the same work)
        // is answered from the existing row instead of charged again. Omitted
        // → firebill mints a per-request UUID (dedupes only its own retries).
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      }),
      signal: AbortSignal.timeout(FIREBILL_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error("firebill track failed — non-OK response", {
        customerId,
        entityId,
        featureId,
        value,
        path,
        status: response.status,
      });
      return false;
    }

    const body = (await response.json()) as { success?: boolean };
    if (body.success !== true) {
      logger.error("firebill track did not succeed", {
        customerId,
        entityId,
        featureId,
        value,
        path,
      });
      return false;
    }

    logger.info("firebill track succeeded", {
      customerId,
      entityId,
      featureId,
      value,
      path,
    });
    return true;
  } catch (error) {
    // DO NOT fall back to calling Autumn directly here: firebill may have
    // durably recorded the event before this call failed and will deliver it
    // to Autumn later, so a direct-Autumn fallback could double-bill the
    // customer. A firebill failure (timeout, 5xx, connection refused) is
    // treated exactly like an Autumn track failure: log and return false.
    logger.error("firebill track failed — firebill may be unavailable", {
      customerId,
      entityId,
      featureId,
      value,
      path,
      error,
    });
    return false;
  }
}

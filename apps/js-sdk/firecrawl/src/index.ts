/**
 * Firecrawl JS/TS SDK — unified entrypoint.
 * - v2 by default on the top‑level client
 * - v1 available under `.v1` (feature‑frozen)
 * - Exports: `Firecrawl` (default), `FirecrawlClient` (v2), `FirecrawlAppV1` (v1), and v2 types
 */

/** Direct v2 client. */
export { FirecrawlClient } from "./v2/client";
/** Public v2 request/response types. */
export * from "./v2/types";
/** Watcher class and options for crawl/batch job monitoring. */
export { Watcher, type WatcherOptions } from "./v2/watcher";
/** Legacy v1 client (feature‑frozen). */
export { default as FirecrawlAppV1 } from "./v1";

import V1 from "./v1";
import { FirecrawlClient as V2, type FirecrawlClientOptions, type FirecrawlClientInput } from "./v2/client";
import type { FirecrawlAppConfig } from "./v1";

// Re-export v2 client options for convenience
export type { FirecrawlClientOptions, FirecrawlClientInput } from "./v2/client";

/** Unified client: extends v2 and adds `.v1` for backward compatibility. */
export class Firecrawl extends V2 {
  /** Feature‑frozen v1 client (lazy). */
  private _v1?: V1;
  private _v1Opts: FirecrawlAppConfig;

  /** @param opts API key string or credentials object. */
  constructor(opts: FirecrawlClientInput = {}) {
    const resolved: FirecrawlClientOptions =
      typeof opts === "string" ? { apiKey: opts } : opts;
    super(resolved);
    this._v1Opts = {
      apiKey: resolved.apiKey,
      apiUrl: resolved.apiUrl,
    };
  }

  /** Access the legacy v1 client (instantiated on first access). */
  get v1(): V1 {
    if (!this._v1) this._v1 = new V1(this._v1Opts);
    return this._v1;
  }
}

export default Firecrawl;


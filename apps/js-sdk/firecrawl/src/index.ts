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
import { FirecrawlClient as V2, type FirecrawlClientOptions } from "./v2/client";
import type { FirecrawlAppConfig } from "./v1";

// Re-export v2 client options for convenience
export type { FirecrawlClientOptions } from "./v2/client";

/** Unified client: extends v2 and adds `.v1` for backward compatibility. */
export class Firecrawl extends V2 {
  /** Feature‑frozen v1 client (lazy). */
  private _v1?: V1;
  private _v1Opts: FirecrawlAppConfig;

  /** @param opts API credentials and base URL. */
  constructor(opts: FirecrawlClientOptions = {}) {
    super(opts);
    this._v1Opts = {
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
    };
  }

  /** Access the legacy v1 client (instantiated on first access). */
  get v1(): V1 {
    if (!this._v1) this._v1 = new V1(this._v1Opts);
    return this._v1;
  }
}

// Copy V2 method descriptors onto Firecrawl.prototype so that
// Object.getOwnPropertyNames(Object.getPrototypeOf(app)) includes them.
(function exposeV2MethodsOnTopLevel() {
  for (const name of Object.getOwnPropertyNames(V2.prototype)) {
    if (name === "constructor") continue;
    if (Object.prototype.hasOwnProperty.call(Firecrawl.prototype, name)) continue;
    const desc = Object.getOwnPropertyDescriptor(V2.prototype, name);
    if (desc) Object.defineProperty(Firecrawl.prototype, name, desc);
  }
})();

export default Firecrawl;


import type * as FDBModule from "foundationdb";
import type { Database } from "foundationdb";
import { config } from "../../../config";

// The foundationdb package loads libfdb_c at require-time. Keep the require
// lazy so processes that never touch the FDB backend (PG-only deploys, unit
// tests, environments without the client library) can still boot.
let fdbModule: typeof FDBModule | null = null;

export function getFdb(): typeof FDBModule {
  if (fdbModule === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fdbModule = require("foundationdb") as typeof FDBModule;
    fdbModule.setAPIVersion(720);
  }
  return fdbModule;
}

let db: Database | null = null;

export function getNuqFdbDatabase(): Database {
  if (db === null) {
    db = getFdb().open(config.FDB_CLUSTER_FILE);
  }
  return db;
}

export function isFdbConfigured(): boolean {
  return !!config.FDB_CLUSTER_FILE || config.NUQ_BACKEND === "fdb";
}

export async function nuqFdbHealthCheck(): Promise<boolean> {
  try {
    await getNuqFdbDatabase().doTn(async tn => {
      await tn.getReadVersion();
    });
    return true;
  } catch {
    return false;
  }
}

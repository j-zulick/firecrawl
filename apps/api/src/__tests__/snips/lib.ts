import { configDotenv } from "dotenv";
configDotenv();

import { TeamFlags } from "../../controllers/v1/types";
import { Client as PgClient } from "pg";

// =========================================
// Configuration
// =========================================

export const TEST_URL = process.env.TEST_API_URL || "http://127.0.0.1:3002";

// Due to the limited resources of the CI runner, we need to set a longer timeout for the many many scrape tests
export const scrapeTimeout = 90000;
export const indexCooldown = 30000;

// =========================================
// idmux
// =========================================

export type IdmuxRequest = {
  name: string;

  concurrency?: number;
  credits?: number;
  tokens?: number;
  flags?: TeamFlags;
  teamId?: string;
};

export async function idmux(req: IdmuxRequest): Promise<Identity> {
  if (!process.env.IDMUX_URL) {
    if (!process.env.TEST_SUITE_SELF_HOSTED) {
      console.warn("IDMUX_URL is not set, using test API key and team ID");
    }
    return {
      apiKey: process.env.TEST_API_KEY!,
      teamId: process.env.TEST_TEAM_ID!,
    };
  }

  let runNumber = parseInt(process.env.GITHUB_RUN_NUMBER!);
  if (isNaN(runNumber) || runNumber === null || runNumber === undefined) {
    runNumber = 0;
  }

  const concurrency = req.concurrency ?? 100;

  const res = await fetch(process.env.IDMUX_URL + "/", {
    method: "POST",
    body: JSON.stringify({
      refName: process.env.GITHUB_REF_NAME!,
      runNumber,
      concurrency,
      ...req,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    console.error(await res.text());
  }

  expect(res.ok).toBe(true);
  const result: Identity = await res.json();

  const nuqClient = new PgClient({
    connectionString: process.env.NUQ_DATABASE_URL,
  });

  // update the concurrency limit for the team in the nuq spoof table
  await nuqClient.query(
    `
    INSERT INTO nuq.queue_scrape_owner_concurrency_source (id, max_concurrency) VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET max_concurrency = EXCLUDED.max_concurrency
  `,
    [result.teamId, concurrency],
  );

  await nuqClient.end();

  return result;
}

export type Identity = {
  apiKey: string;
  teamId: string;
};

import { z } from "zod";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import {
  createMonitor,
  listMonitors,
  getMonitorForUpdate,
  updateMonitor,
} from "../../monitoring/store";
import { validateMonitorCron } from "../../monitoring/cron";
import { createMonitorSchema } from "../../monitoring/types";
import type { SlackInstallationRow } from "./types";
import { escapeSlackText, slackLink } from "./messages";

const logger = _logger.child({ module: "slack-commands" });

type SlackCommandResponse = {
  response_type: "ephemeral" | "in_channel";
  text: string;
  blocks?: unknown[];
};

type SlackSlashCommandInput = {
  installation: SlackInstallationRow;
  text: string;
  channelId: string;
  channelName: string;
  userId: string;
};

const DEFAULT_WATCH_CRON = "0 9 * * *"; // daily at 09:00 UTC

function dashboardUrl(path: string): string {
  return new URL(path, config.FIRECRAWL_DASHBOARD_URL).toString();
}

function ephemeral(text: string, blocks?: unknown[]): SlackCommandResponse {
  return { response_type: "ephemeral", text, blocks };
}

function helpResponse(): SlackCommandResponse {
  const lines = [
    "*Firecrawl monitor commands*",
    "`/monitor watch <url>` — start monitoring a page and post changes to this channel",
    "`/monitor list` — list your team's monitors",
    "`/monitor cancel <monitor-id>` — pause a monitor",
    "`/monitor status` — show this workspace's Firecrawl connection",
    "`/monitor help` — show this help",
    "",
    `Manage everything in the ${slackLink(dashboardUrl("/app/monitoring"), "dashboard")}.`,
  ];
  return ephemeral(lines.join("\n"));
}

function statusResponse(
  installation: SlackInstallationRow,
): SlackCommandResponse {
  const workspace = installation.slack_team_name ?? installation.slack_team_id;
  return ephemeral(
    [
      `:white_check_mark: This Slack workspace (*${escapeSlackText(workspace)}*) is linked to your Firecrawl account.`,
      "Monitors created here bill your team's API key automatically — no key to paste.",
      `Open the ${slackLink(dashboardUrl("/app/monitoring"), "monitoring dashboard")} to configure more.`,
    ].join("\n"),
  );
}

async function listResponse(
  installation: SlackInstallationRow,
): Promise<SlackCommandResponse> {
  const monitors = await listMonitors({
    teamId: installation.team_id,
    limit: 20,
    offset: 0,
  });

  if (monitors.length === 0) {
    return ephemeral(
      `You don't have any monitors yet. Try \`/monitor watch https://example.com\` or open the ${slackLink(
        dashboardUrl("/app/monitoring/new"),
        "dashboard",
      )}.`,
    );
  }

  const lines = monitors.map(m => {
    const statusEmoji = m.status === "active" ? ":green_circle:" : ":pause_button:";
    const slackOn =
      (m.notification as { slack?: { enabled?: boolean } } | null)?.slack
        ?.enabled === true
        ? " · Slack on"
        : "";
    return `${statusEmoji} *${escapeSlackText(m.name)}* — \`${m.id}\`${slackOn}`;
  });

  return ephemeral(
    [`*Your monitors (${monitors.length}):*`, ...lines].join("\n"),
  );
}

async function watchResponse(
  input: SlackSlashCommandInput,
  rawUrl: string,
): Promise<SlackCommandResponse> {
  let url: string;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    url = parsed.toString();
  } catch {
    return ephemeral(
      `\`${escapeSlackText(rawUrl)}\` doesn't look like a valid URL. Try \`/monitor watch https://example.com\`.`,
    );
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }

  try {
    const parsedInput = createMonitorSchema.parse({
      name: `Slack: ${host}`,
      schedule: { cron: DEFAULT_WATCH_CRON, timezone: "UTC" },
      targets: [
        {
          type: "scrape",
          urls: [url],
          scrapeOptions: { formats: ["markdown"] },
        },
      ],
      notification: {
        slack: {
          enabled: true,
          channelId: input.channelId,
          channelName: input.channelName,
        },
      },
      origin: "slack",
    });

    const schedule = validateMonitorCron(
      parsedInput.schedule.cron,
      parsedInput.schedule.timezone,
    );

    const monitor = await createMonitor({
      teamId: input.installation.team_id,
      input: parsedInput,
      nextRunAt: schedule.nextRunAt,
      intervalMs: schedule.intervalMs,
    });

    return ephemeral(
      [
        `:fire: Now monitoring ${slackLink(url)} — changes will be posted to *#${escapeSlackText(
          input.channelName,
        )}*.`,
        `Runs daily. Manage it in the ${slackLink(
          dashboardUrl(`/app/monitoring/${monitor.id}`),
          "dashboard",
        )} (\`${monitor.id}\`).`,
        `_Tip: if you don't see alerts in a private channel, invite the bot with \`/invite @Firecrawl\`._`,
      ].join("\n"),
    );
  } catch (error) {
    logger.warn("Failed to create monitor from slash command", {
      error,
      teamId: input.installation.team_id,
    });
    return ephemeral(
      "Sorry, I couldn't create that monitor. Please try again from the dashboard.",
    );
  }
}

async function cancelResponse(
  installation: SlackInstallationRow,
  monitorId: string,
): Promise<SlackCommandResponse> {
  const trimmed = monitorId.trim();

  // Validate the id shape first: a non-UUID arg gets a friendly message and
  // avoids hitting the DB with an invalid uuid cast (which would throw).
  if (!z.uuid().safeParse(trimmed).success) {
    return ephemeral(
      `\`${escapeSlackText(trimmed)}\` isn't a valid monitor id. Use \`/monitor list\` to find it.`,
    );
  }

  // No catch here on purpose: a valid-but-missing id returns null, while real
  // backend errors propagate to the command handler's try/catch so we don't
  // disguise a failure as "not found".
  const existing = await getMonitorForUpdate(installation.team_id, trimmed);
  if (!existing) {
    return ephemeral(
      `I couldn't find a monitor with id \`${escapeSlackText(trimmed)}\` on your team.`,
    );
  }

  const updated = await updateMonitor({
    teamId: installation.team_id,
    monitorId: trimmed,
    input: { status: "paused" },
  });

  if (!updated) {
    return ephemeral("Sorry, I couldn't pause that monitor. Try the dashboard.");
  }

  return ephemeral(
    `:pause_button: Paused *${escapeSlackText(updated.name)}* (\`${updated.id}\`). Resume it anytime from the ${slackLink(
      dashboardUrl(`/app/monitoring/${updated.id}`),
      "dashboard",
    )}.`,
  );
}

// Routes a parsed /monitor invocation to the right sub-handler.
export async function handleSlashCommand(
  input: SlackSlashCommandInput,
): Promise<SlackCommandResponse> {
  const text = input.text.trim();
  const [subcommand, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();

  switch ((subcommand || "help").toLowerCase()) {
    case "":
    case "help":
      return helpResponse();
    case "status":
      return statusResponse(input.installation);
    case "list":
    case "ls":
      return listResponse(input.installation);
    case "watch":
    case "add":
      if (!arg) {
        return ephemeral("Usage: `/monitor watch <url>`");
      }
      return watchResponse(input, arg);
    case "cancel":
    case "pause":
    case "stop":
      if (!arg) {
        return ephemeral("Usage: `/monitor cancel <monitor-id>`");
      }
      return cancelResponse(input.installation, arg);
    default:
      // Bare `/monitor <url>` is a convenient alias for watch.
      if (/^https?:\/\//i.test(text)) {
        return watchResponse(input, text);
      }
      return helpResponse();
  }
}

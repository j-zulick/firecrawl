import amqp from "amqplib";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

const MONITOR_CHECK_QUEUE = "monitor.checks";
const MONITOR_CHECK_DLX = "monitor.checks.dlx";
const MONITOR_CHECK_DLQ = "monitor.checks.dlq";

// Search checks are far heavier than scrape/crawl checks, so they get a dedicated
// queue + consumer — a burst of them can't starve the page/site/batch checks.
const MONITOR_SEARCH_CHECK_QUEUE = "monitor.checks.search";
const MONITOR_SEARCH_CHECK_DLX = "monitor.checks.search.dlx";
const MONITOR_SEARCH_CHECK_DLQ = "monitor.checks.search.dlq";

const logger = _logger.child({ module: "monitoring-queue" });

export type MonitorCheckJobData = {
  monitorId: string;
  checkId: string;
  teamId: string;
};

let connection: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

// Declare a check queue + its dead-letter exchange/queue (same topology for both).
async function assertCheckQueue(
  ch: amqp.Channel,
  queue: string,
  dlx: string,
  dlq: string,
): Promise<void> {
  await ch.assertExchange(dlx, "direct", { durable: true });
  await ch.assertQueue(dlq, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
    },
  });
  await ch.bindQueue(dlq, dlx, queue);
  await ch.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": dlx,
      "x-dead-letter-routing-key": queue,
      "x-delivery-limit": 1,
    },
  });
}

async function getChannel(): Promise<amqp.Channel> {
  if (channel) return channel;

  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  connection = await amqp.connect(url);
  channel = await connection.createChannel();

  await assertCheckQueue(
    channel,
    MONITOR_CHECK_QUEUE,
    MONITOR_CHECK_DLX,
    MONITOR_CHECK_DLQ,
  );
  await assertCheckQueue(
    channel,
    MONITOR_SEARCH_CHECK_QUEUE,
    MONITOR_SEARCH_CHECK_DLX,
    MONITOR_SEARCH_CHECK_DLQ,
  );

  connection.on("close", () => {
    logger.warn("Monitor queue connection closed");
    connection = null;
    channel = null;
  });

  connection.on("error", error => {
    logger.error("Monitor queue connection error", { error });
  });

  return channel;
}

export async function addMonitorCheckJob(
  data: MonitorCheckJobData,
  opts: { search?: boolean } = {},
): Promise<void> {
  const ch = await getChannel();
  const queue = opts.search ? MONITOR_SEARCH_CHECK_QUEUE : MONITOR_CHECK_QUEUE;
  const sent = ch.sendToQueue(queue, Buffer.from(JSON.stringify(data)), {
    persistent: true,
    contentType: "application/json",
    messageId: data.checkId,
  });

  if (!sent) {
    logger.warn("Monitor check message buffer full", {
      monitorId: data.monitorId,
      checkId: data.checkId,
      queue,
    });
  }

  logger.info("Monitor check job added to queue", {
    monitorId: data.monitorId,
    checkId: data.checkId,
    teamId: data.teamId,
    queue,
  });
}

async function consumeQueue(
  queue: string,
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  const ch = await getChannel();
  // Per-consumer prefetch (amqplib default): each consumer gets its own in-flight
  // slot, so the search and default consumers don't block each other.
  await ch.prefetch(1);

  await ch.consume(
    queue,
    async msg => {
      if (!msg) return;

      let data: MonitorCheckJobData;
      try {
        data = JSON.parse(msg.content.toString()) as MonitorCheckJobData;
      } catch (error) {
        logger.error("Failed to parse monitor check job", { error });
        ch.nack(msg, false, false);
        return;
      }

      const jobLogger = logger.child({
        monitorId: data.monitorId,
        checkId: data.checkId,
        teamId: data.teamId,
      });

      try {
        await handler(data);
        ch.ack(msg);
      } catch (error) {
        jobLogger.error("Monitor check job failed", { error });
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );

  logger.info("Started consuming monitor check jobs", { queue });
}

export async function consumeMonitorCheckJobs(
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  await consumeQueue(MONITOR_CHECK_QUEUE, handler);
}

export async function consumeMonitorSearchCheckJobs(
  handler: (data: MonitorCheckJobData) => Promise<void>,
): Promise<void> {
  await consumeQueue(MONITOR_SEARCH_CHECK_QUEUE, handler);
}

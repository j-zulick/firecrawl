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

type ConsumerHandler = (data: MonitorCheckJobData) => Promise<void>;

let connection: amqp.ChannelModel | null = null;
// Publish and consume use separate channels: a channel exception on one side
// (a failed publish, or a PRECONDITION_FAILED on assert) must not tear down the
// other.
let publishChannel: amqp.Channel | null = null;
let consumeChannel: amqp.Channel | null = null;

// Registry of every consumer registered this process, so we can re-attach them
// after a connection/channel drop. Without this the worker — which never
// produces and so never re-triggers channel creation — goes permanently deaf
// after any RabbitMQ blip, and only a restart heals it.
const registeredConsumers: Array<{ queue: string; handler: ConsumerHandler }> =
  [];
// Queues with a live consumer on the CURRENT consume channel. Cleared whenever
// the channel drops, so a reconnect re-subscribes exactly once per queue and
// repeated drops can't pile up duplicate consumers.
const subscribedQueues = new Set<string>();
let reconnectInFlight = false;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

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

async function assertTopology(ch: amqp.Channel): Promise<void> {
  await assertCheckQueue(
    ch,
    MONITOR_CHECK_QUEUE,
    MONITOR_CHECK_DLX,
    MONITOR_CHECK_DLQ,
  );
  await assertCheckQueue(
    ch,
    MONITOR_SEARCH_CHECK_QUEUE,
    MONITOR_SEARCH_CHECK_DLX,
    MONITOR_SEARCH_CHECK_DLQ,
  );
}

// Drop all cached state and, if any consumers were registered, kick off a
// backoff reconnect that re-asserts topology and re-subscribes every consumer.
function handleConnectionDrop(reason: string, error?: unknown): void {
  if (connection || publishChannel || consumeChannel) {
    logger.warn("Monitor queue dropped — will reconnect", { reason, error });
  }
  connection = null;
  publishChannel = null;
  consumeChannel = null;
  subscribedQueues.clear();
  if (registeredConsumers.length > 0) {
    scheduleReconnect(RECONNECT_BASE_DELAY_MS);
  }
}

function scheduleReconnect(delayMs: number): void {
  if (reconnectInFlight) return;
  reconnectInFlight = true;

  setTimeout(async () => {
    try {
      const ch = await getConsumeChannel();
      for (const { queue, handler } of registeredConsumers) {
        await subscribe(ch, queue, handler);
      }
      reconnectInFlight = false;
      logger.info("Monitor queue reconnected; consumers re-subscribed", {
        consumers: registeredConsumers.length,
      });
    } catch (error) {
      reconnectInFlight = false;
      const nextDelay = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      logger.error("Monitor queue reconnect failed; retrying", {
        error,
        nextDelayMs: nextDelay,
      });
      connection = null;
      publishChannel = null;
      consumeChannel = null;
      scheduleReconnect(nextDelay);
    }
  }, delayMs);
}

async function getConnection(): Promise<amqp.ChannelModel> {
  if (connection) return connection;

  const url = config.NUQ_RABBITMQ_URL;
  if (!url) {
    throw new Error("NUQ_RABBITMQ_URL is not configured");
  }

  // Name the connection so operators can identify (and isolate) monitoring
  // traffic in `rabbitmqctl list_connections` / the management UI.
  const conn = await amqp.connect(url, {
    clientProperties: { connection_name: "monitoring-queue" },
  });
  conn.on("close", () => handleConnectionDrop("connection closed"));
  conn.on("error", error =>
    logger.error("Monitor queue connection error", { error }),
  );
  connection = conn;
  return conn;
}

async function createChannel(label: string): Promise<amqp.Channel> {
  const conn = await getConnection();
  const ch = await conn.createChannel();
  await assertTopology(ch);
  // Channels can close independently of the connection (e.g. a
  // PRECONDITION_FAILED from assertQueue). Without these handlers the cached
  // channel would stay non-null and every send/consume would throw forever.
  ch.on("close", () => {
    if (label === "publish" && publishChannel === ch) publishChannel = null;
    if (label === "consume" && consumeChannel === ch) {
      consumeChannel = null;
      handleConnectionDrop("consume channel closed");
    }
  });
  ch.on("error", error =>
    logger.error("Monitor queue channel error", { label, error }),
  );
  return ch;
}

async function getPublishChannel(): Promise<amqp.Channel> {
  if (publishChannel) return publishChannel;
  publishChannel = await createChannel("publish");
  return publishChannel;
}

async function getConsumeChannel(): Promise<amqp.Channel> {
  if (consumeChannel) return consumeChannel;
  consumeChannel = await createChannel("consume");
  return consumeChannel;
}

export async function addMonitorCheckJob(
  data: MonitorCheckJobData,
  opts: { search?: boolean } = {},
): Promise<void> {
  const ch = await getPublishChannel();
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
  handler: ConsumerHandler,
): Promise<void> {
  // Record the registration so a reconnect can re-attach this consumer.
  if (!registeredConsumers.some(c => c.queue === queue)) {
    registeredConsumers.push({ queue, handler });
  }
  const ch = await getConsumeChannel();
  await subscribe(ch, queue, handler);
}

async function subscribe(
  ch: amqp.Channel,
  queue: string,
  handler: ConsumerHandler,
): Promise<void> {
  // Already consuming this queue on the current channel — don't add a duplicate
  // (a reconnect could otherwise re-subscribe an already-subscribed queue).
  if (subscribedQueues.has(queue)) return;
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

  subscribedQueues.add(queue);
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

import { Logger } from "winston";
import { logger } from "../../lib/logger";
import { Client, Pool } from "pg";
import { type ScrapeJobData } from "../../types";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import amqp from "amqplib";
import { v5 as uuidv5, validate as uuidValidate } from "uuid";

// === Basics

const nuqPool = new Pool({
  connectionString: process.env.NUQ_DATABASE_URL, // may be a pgbouncer transaction pooler URL
  application_name: "nuq",
});

nuqPool.on("error", err =>
  logger.error("Error in NuQ idle client", { err, module: "nuq" }),
);

export type NuQJobStatus = "queued" | "active" | "completed" | "failed"; // must match nuq.job_status enum
export type NuQJob<Data = any, ReturnValue = any> = {
  id: string;
  status: NuQJobStatus;
  createdAt: Date;
  priority: number;
  data: Data;
  finishedAt?: Date;
  listenChannelId?: string;
  returnvalue?: ReturnValue;
  failedReason?: string;
  lock?: string;
  ownerId?: string;
  groupId?: string;
  timesOutAt?: Date;
};

const listenChannelId = process.env.NUQ_POD_NAME ?? "main";

// === Queue

type NuQOptions = {
  concurrencyLimit?: false | "per-owner" | "per-owner-per-group";
};

type NuQJobOptions = {
  listenable?: boolean;
  priority?: number;
  ownerId?: string;
  groupId?: string;
  timesOutAt?: Date;
};

function normalizeOwnerId(ownerId: string | undefined | null) {
  const bareOwnerId = ownerId ?? undefined;
  const normalizedOwnerId = bareOwnerId
    ? uuidValidate(bareOwnerId)
      ? bareOwnerId
      : uuidv5(bareOwnerId, "b208cbac-8bdf-4599-bf17-da78426e3f7c") // preview namespace
    : null;
  return normalizedOwnerId;
}

class NuQ<JobData = any, JobReturnValue = any> {
  constructor(
    public readonly queueName: string,
    public readonly options: NuQOptions = { concurrencyLimit: false },
  ) {}

  // === Listener

  private listener:
    | {
        type: "postgres";
        client: Client;
      }
    | {
        type: "rabbitmq";
        connection: amqp.ChannelModel;
        channel: amqp.Channel;
        queue: string;
      }
    | null = null;
  private listens: {
    [key: string]: ((status: "completed" | "failed") => void)[];
  } = {};
  private shuttingDown = false;

  private async startListener() {
    if (this.listener || this.shuttingDown) return;

    if (process.env.NUQ_RABBITMQ_URL) {
      const connection = await amqp.connect(process.env.NUQ_RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.prefetch(1);
      const queue = await channel.assertQueue(
        this.queueName + ".listen." + listenChannelId,
        {
          exclusive: true,
          autoDelete: true,
          durable: false,
          arguments: {
            "x-queue-type": "classic",
            "x-message-ttl": 60000,
          },
        },
      );

      this.listener = {
        type: "rabbitmq",
        connection,
        channel,
        queue: queue.queue,
      };

      let reconnectTimeout: NodeJS.Timeout | null = null;

      const onClose = function onClose() {
        logger.info("NuQ listener channel closed", {
          module: "nuq/rabbitmq",
        });
        this.listener = null;

        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(
          (() => {
            this.startListener().catch(err =>
              logger.error("Error in NuQ listener reconnect", {
                err,
                module: "nuq/rabbitmq",
              }),
            );
          }).bind(this),
          250,
        );
        return;
      }.bind(this);

      connection.on("close", onClose);
      channel.on("close", onClose);

      await this.listener.channel.consume(
        this.listener.queue,
        (msg => {
          if (msg === null) {
            onClose();
            return;
          }

          logger.info("NuQ job received", {
            module: "nuq/rabbitmq",
            jobId: msg.properties.correlationId,
            status: msg.content.toString(),
          });

          const jobId = msg.properties.correlationId as string;
          const status = msg.content.toString() as "completed" | "failed";

          if (jobId in this.listens) {
            this.listens[jobId].forEach(listener => listener(status));
          }
          delete this.listens[jobId];

          if (this.listener && this.listener.type === "rabbitmq") {
            this.listener.channel.ack(msg);
          }
        }).bind(this),
        {
          noAck: false,
        },
      );
    } else {
      this.listener = {
        type: "postgres",
        client: new Client({
          connectionString:
            process.env.NUQ_DATABASE_URL_LISTEN ?? process.env.NUQ_DATABASE_URL, // will always be a direct connection
          application_name: "nuq_listener",
        }),
      };

      this.listener.client.on("notification", msg => {
        const tok = (msg.payload ?? "unknown|unknown").split("|");
        if (tok[0] in this.listens) {
          this.listens[tok[0]].forEach(listener =>
            listener(tok[1] as "completed" | "failed"),
          );
          delete this.listens[tok[0]];
        }
      });

      this.listener.client.on("error", err =>
        logger.error("Error in NuQ listener", { err, module: "nuq" }),
      );

      this.listener.client.on("end", () => {
        logger.info("NuQ listener disconnected", { module: "nuq" });
        this.listener = null;
        setTimeout(
          (() => {
            this.startListener().catch(err =>
              logger.error("Error in NuQ listener reconnect", {
                err,
                module: "nuq",
              }),
            );
          }).bind(this),
          250,
        );
      });

      await this.listener.client.connect();
      await this.listener.client.query(`LISTEN "${this.queueName}";`);
    }

    (async () => {
      const backedUpJobs = (
        await this.getJobs(Object.keys(this.listens))
      ).filter(job => ["completed", "failed"].includes(job.status));
      for (const job of backedUpJobs) {
        this.listens[job.id].forEach(listener =>
          listener(job.status as "completed" | "failed"),
        );
        delete this.listens[job.id];
      }
    })();
  }

  private async addListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    await this.startListener();

    if (!(id in this.listens)) this.listens[id] = [listener];
    else this.listens[id].push(listener);
  }

  private async removeListener(
    id: string,
    listener: (status: "completed" | "failed") => void,
  ) {
    if (id in this.listens) {
      this.listens[id] = this.listens[id].filter(l => l !== listener);
      if (this.listens[id].length === 0) delete this.listens[id];
    }
  }

  // === Sender

  private sender: {
    type: "rabbitmq";
    connection: amqp.ChannelModel;
    channel: amqp.Channel;
  } | null = null;

  private async startSender() {
    if (this.sender || this.shuttingDown) return;

    if (process.env.NUQ_RABBITMQ_URL) {
      const connection = await amqp.connect(process.env.NUQ_RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertQueue(this.queueName + ".prefetch", {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-max-length": 20000,
        },
      });

      this.sender = {
        type: "rabbitmq",
        connection,
        channel,
      };

      channel.on("close", () => {
        logger.info("NuQ sender channel closed", { module: "nuq/rabbitmq" });
        connection.close().catch(() => {});
        this.sender = null;
      });

      connection.on("close", () => {
        logger.info("NuQ sender connection closed", { module: "nuq/rabbitmq" });
        this.sender = null;
      });
    }
  }

  private async sendJobEnd(
    id: string,
    status: "completed" | "failed",
    listenChannelId: string,
    _logger: Logger = logger,
  ) {
    await this.startSender();

    if (this.sender) {
      this.sender.channel.sendToQueue(
        this.queueName + ".listen." + listenChannelId,
        Buffer.from(status, "utf8"),
        {
          correlationId: id,
        },
      );
      _logger.info("NuQ job sent", { module: "nuq/rabbitmq" });
    } else {
      _logger.warn("NuQ sender not started", { module: "nuq/rabbitmq" });
    }
  }

  private async sendJobPrefetch(
    job: NuQJob<JobData, JobReturnValue>,
    _logger: Logger = logger,
  ) {
    await this.startSender();

    if (this.sender) {
      this.sender.channel.sendToQueue(
        this.queueName + ".prefetch",
        Buffer.from(JSON.stringify(job), "utf8"),
        {
          correlationId: job.id,
          persistent: true,
          expiration: "15000", // has to expire in 15s otherwise locks will fail to be acquired for jobs that got picked up late
        },
      );
      _logger.info("NuQ job prefetch sent", { module: "nuq/rabbitmq" });
    } else {
      _logger.warn("NuQ sender not started", { module: "nuq/rabbitmq" });
    }
  }

  // === Job management

  private readonly jobReturning = [
    "id",
    "status",
    "created_at",
    "priority",
    "data",
    "finished_at",
    "listen_channel_id",
    "returnvalue",
    "failedreason",
    "lock",
    "owner_id",
    "group_id",
    "times_out_at",
  ];

  private rowToJob(row: any): NuQJob<JobData, JobReturnValue> | null {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at),
      priority: row.priority,
      data: row.data,
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      listenChannelId: row.listen_channel_id ?? undefined,
      returnvalue: row.returnvalue ?? undefined,
      failedReason: row.failedreason ?? undefined,
      lock: row.lock ?? undefined,
      ownerId: row.owner_id ?? undefined,
      groupId: row.group_id ?? undefined,
      timesOutAt: row.times_out_at ? new Date(row.times_out_at) : undefined,
    };
  }

  public async getJob(
    id: string,
    _logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan("nuq.getJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
      });

      const start = Date.now();
      try {
        const result = this.rowToJob(
          (
            await nuqPool.query(
              `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = $1;`,
              [id],
            )
          ).rows[0],
        );

        setSpanAttributes(span, {
          "nuq.job_found": result !== null,
          "nuq.job_status": result?.status,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqGetJob metrics", {
          module: "nuq/metrics",
          method: "nuqGetJob",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  public async getJobs(
    ids: string[],
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]);`,
          [ids],
        )
      ).rows.map(row => this.rowToJob(row)!);
    } finally {
      _logger.info("nuqGetJobs metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobs",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  public async getJobsWithStatus(
    ids: string[],
    status: NuQJobStatus,
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = $2::nuq.job_status;`,
          [ids, status],
        )
      ).rows.map(row => this.rowToJob(row)!);
    } finally {
      _logger.info("nuqGetJobsWithStatus metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsWithStatus",
        duration: Date.now() - start,
        scrapeIds: ids.length,
        status,
      });
    }
  }

  public async getJobsWithStatuses(
    ids: string[],
    statuses: NuQJobStatus[],
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (ids.length === 0) return [];

    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName} WHERE ${this.queueName}.id = ANY($1::uuid[]) AND ${this.queueName}.status = ANY($2::nuq.job_status[]);`,
          [ids, statuses],
        )
      ).rows.map(row => this.rowToJob(row)!);
    } finally {
      _logger.info("nuqGetJobsWithStatuses metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsWithStatuses",
        duration: Date.now() - start,
        scrapeIds: ids.length,
        statuses,
      });
    }
  }

  public async getJobCountsOfGroup(
    groupId: string,
    _logger: Logger = logger,
  ): Promise<Record<NuQJobStatus, number>> {
    const start = Date.now();
    try {
      const stats = await nuqPool.query(
        `
        SELECT status, COUNT(*) as count FROM nuq.queue_scrape WHERE group_id = $1 GROUP BY status;
      `,
        [groupId],
      );

      return Object.fromEntries(stats.rows.map(x => [x.status, x.count]));
    } finally {
      _logger.info("nuqGetJobCountsOfGroup metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobCountsOfGroup",
        duration: Date.now() - start,
        groupId,
      });
    }
  }

  public async getJobsOfGroupWithStatus(
    groupId: string,
    status: NuQJobStatus,
    limit: number,
    offset: number,
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    const start = Date.now();
    try {
      return (
        await nuqPool.query(
          `
        SELECT ${this.jobReturning.join(", ")} FROM ${this.queueName}
        WHERE group_id = $1 AND status = $2
        ORDER BY finished_at ASC
        LIMIT $3 OFFSET $4
      `,
          [groupId, status, limit, offset],
        )
      ).rows.map(x => this.rowToJob(x)!);
    } finally {
      _logger.info("nuqGetJobsOfGroupWithStatus metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobsOfGroupWithStatus",
        duration: Date.now() - start,
        groupId,
      });
    }
  }

  public async removeJob(
    id: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(`DELETE FROM ${this.queueName} WHERE id = $1;`, [
            id,
          ])
        ).rowCount !== 0
      );
    } finally {
      _logger.info("nuqRemoveJob metrics", {
        module: "nuq/metrics",
        method: "nuqRemoveJob",
        duration: Date.now() - start,
        scrapeId: id,
      });
    }
  }

  public async removeJobs(
    ids: string[],
    _logger: Logger = logger,
  ): Promise<number> {
    if (ids.length === 0) return 0;

    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(
            `DELETE FROM ${this.queueName} WHERE id = ANY($1::uuid[]);`,
            [ids],
          )
        ).rowCount ?? 0
      );
    } finally {
      _logger.info("nuqRemoveJobs metrics", {
        module: "nuq/metrics",
        method: "nuqRemoveJobs",
        duration: Date.now() - start,
        scrapeIds: ids.length,
      });
    }
  }

  // === Producer
  public async tryAddJob(
    id: string,
    data: JobData,
    options: NuQJobOptions = {},
  ): Promise<NuQJob<JobData, JobReturnValue> | null> {
    return withSpan("nuq.tryAddJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": options.priority ?? 0,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": options.listenable ?? false,
      });

      const start = Date.now();
      try {
        const result = this.rowToJob(
          (
            await nuqPool.query(
              `INSERT INTO ${this.queueName} (id, data, priority, listen_channel_id, owner_id, group_id, times_out_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING ${this.jobReturning.join(", ")};`,
              [
                id,
                data,
                options.priority ?? 0,
                options.listenable ? listenChannelId : null,
                normalizeOwnerId(options.ownerId) ?? null,
                options.groupId ?? null,
                options.timesOutAt ? options.timesOutAt.toISOString() : null,
              ],
            )
          ).rows[0],
        )!;

        setSpanAttributes(span, {
          "nuq.job_created": result !== null,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        logger.info("nuqAddJob metrics", {
          module: "nuq/metrics",
          method: "nuqAddJob",
          duration,
          scrapeId: id,
          zeroDataRetention: (data as any)?.zeroDataRetention ?? false,
        });
      }
    });
  }

  public async addJob(
    id: string,
    data: JobData,
    options: NuQJobOptions = {},
  ): Promise<NuQJob<JobData, JobReturnValue>> {
    return withSpan("nuq.addJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.priority": options.priority ?? 0,
        "nuq.zero_data_retention": (data as any)?.zeroDataRetention ?? false,
        "nuq.listenable": options.listenable ?? false,
      });

      const start = Date.now();
      try {
        const result = this.rowToJob(
          (
            await nuqPool.query(
              `INSERT INTO ${this.queueName} (id, data, priority, listen_channel_id, owner_id, group_id, times_out_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${this.jobReturning.join(", ")};`,
              [
                id,
                data,
                options.priority ?? 0,
                options.listenable ? listenChannelId : null,
                normalizeOwnerId(options.ownerId) ?? null,
                options.groupId ?? null,
                options.timesOutAt ? options.timesOutAt.toISOString() : null,
              ],
            )
          ).rows[0],
        )!;

        setSpanAttributes(span, {
          "nuq.job_created": true,
        });

        return result;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        logger.info("nuqAddJob metrics", {
          module: "nuq/metrics",
          method: "nuqAddJob",
          duration,
          scrapeId: id,
          zeroDataRetention: (data as any)?.zeroDataRetention ?? false,
        });
      }
    });
  }

  public async addJobs(
    jobs: Array<{
      id: string;
      data: JobData;
      options?: NuQJobOptions;
    }>,
    _logger: Logger = logger,
  ): Promise<NuQJob<JobData, JobReturnValue>[]> {
    if (jobs.length === 0) return [];

    return withSpan("nuq.addJobs", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_count": jobs.length,
      });

      const start = Date.now();
      try {
        // Prepare arrays for bulk insert
        const ids: string[] = [];
        const dataArray: JobData[] = [];
        const priorities: number[] = [];
        const listenChannelIds: (string | null)[] = [];
        const ownerIds: (string | null)[] = [];
        const groupIds: (string | null)[] = [];
        const timesOutAts: (string | null)[] = [];

        for (const job of jobs) {
          ids.push(job.id);
          dataArray.push(job.data);
          priorities.push(job.options?.priority ?? 0);
          listenChannelIds.push(
            job.options?.listenable ? listenChannelId : null,
          );
          ownerIds.push(normalizeOwnerId(job.options?.ownerId));
          groupIds.push(job.options?.groupId ?? null);
          timesOutAts.push(
            job.options?.timesOutAt
              ? job.options.timesOutAt.toISOString()
              : null,
          );
        }

        // Bulk insert using UNNEST
        const result = await nuqPool.query(
          `INSERT INTO ${this.queueName} (id, data, priority, listen_channel_id, owner_id, group_id, times_out_at)
          SELECT * FROM UNNEST($1::uuid[], $2::jsonb[], $3::int[], $4::text[], $5::uuid[], $6::uuid[], $7::timestamptz[])
          RETURNING ${this.jobReturning.join(", ")};`,
          [
            ids,
            dataArray,
            priorities,
            listenChannelIds,
            ownerIds,
            groupIds,
            timesOutAts,
          ],
        );

        const createdJobs = result.rows.map(row => this.rowToJob(row)!);

        setSpanAttributes(span, {
          "nuq.jobs_created": createdJobs.length,
        });

        return createdJobs;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqAddJobs metrics", {
          module: "nuq/metrics",
          method: "nuqAddJobs",
          duration,
          jobCount: jobs.length,
        });
      }
    });
  }

  private readonly nuqWaitMode =
    process.env.NUQ_WAIT_MODE === "listen" || process.env.NUQ_RABBITMQ_URL
      ? ("listen" as const)
      : ("poll" as const);

  public waitForJob(
    id: string,
    timeout: number | null,
    _logger: Logger = logger,
  ): Promise<JobReturnValue> {
    return withSpan("nuq.waitForJob", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.timeout": timeout ?? undefined,
        "nuq.wait_mode": this.nuqWaitMode,
      });

      const startTime = Date.now();

      const done = new Promise<JobReturnValue>(
        (async (resolve, reject) => {
          if (this.nuqWaitMode === "listen") {
            let timer: NodeJS.Timeout | null = null;
            if (timeout !== null) {
              timer = setTimeout(
                (() => {
                  this.removeListener(id, listener);
                  reject(new Error("Timed out"));
                }).bind(this),
                timeout,
              );
            }

            const listener = async function (_msg: "completed" | "failed") {
              if (timer) clearTimeout(timer);
              const job = await this.getJob(id, _logger);
              if (!job) {
                reject(new Error("Job raced out while waiting for it"));
              } else {
                if (job.status === "completed") {
                  resolve(job.returnvalue!);
                } else {
                  reject(new Error(job.failedReason!));
                }
              }
            }.bind(this);

            try {
              await this.addListener(id, listener);
            } catch (e) {
              reject(e);
            }

            try {
              const job = await this.getJob(id, _logger);
              if (job && ["completed", "failed"].includes(job.status)) {
                this.removeListener(id, listener);
                if (timer) clearTimeout(timer);
                if (job.status === "completed") {
                  resolve(job.returnvalue!);
                } else {
                  reject(new Error(job.failedReason!));
                }
                return;
              }
            } catch (e) {
              _logger.warn("nuqGetJob ensure check failed", {
                module: "nuq",
                method: "nuqWaitForJob",
                error: e,
                scrapeId: id,
              });
            }
          } else {
            const timeoutAt = timeout !== null ? Date.now() + timeout : null;
            const poll = async function poll() {
              try {
                const job = await this.getJob(id, _logger);
                if (job && ["completed", "failed"].includes(job.status)) {
                  if (job.status === "completed") {
                    return resolve(job.returnvalue!);
                  } else {
                    return reject(new Error(job.failedReason!));
                  }
                }
              } catch (e) {
                return reject(e);
              }

              if (timeoutAt && Date.now() > timeoutAt) {
                return reject(new Error("Timed out"));
              }

              setTimeout(poll.bind(this), 500);
            }.bind(this);

            poll();
          }
        }).bind(this),
      );

      const result = await done;

      setSpanAttributes(span, {
        "nuq.wait_duration_ms": Date.now() - startTime,
        "nuq.wait_success": true,
      });

      return result;
    });
  }

  // === Prefetch

  public async prefetchJobs(_logger: Logger = logger): Promise<number> {
    const start = Date.now();
    try {
      let updateQuery: string;
      if (this.options.concurrencyLimit === "per-owner") {
        updateQuery = `
          WITH owner_active_counts AS (
            SELECT
              owner_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
            GROUP BY owner_id
          ),
          owner_limited_jobs AS (
            SELECT
              q.id,
              q.owner_id,
              ROW_NUMBER() OVER (
                PARTITION BY q.owner_id
                ORDER BY q.priority ASC, q.created_at ASC, q.id ASC
              ) as owner_rank,
              GREATEST(
                COALESCE(oc.max_concurrency, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(q.owner_id))
                - COALESCE(oac.active_count, 0),
                0
              ) as owner_limit
            FROM ${this.queueName} q
            LEFT JOIN ${this.queueName}_owner_concurrency oc ON oc.id = q.owner_id
            LEFT JOIN owner_active_counts oac ON oac.owner_id = q.owner_id
            WHERE q.status = 'queued'::nuq.job_status
          ),
          selected_jobs_with_metadata AS (
            SELECT id, owner_id
            FROM owner_limited_jobs
            WHERE owner_rank <= owner_limit
          ),
          missing_owners AS (
            SELECT DISTINCT owner_id
            FROM selected_jobs_with_metadata
            WHERE owner_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_owner_concurrency oc
                WHERE oc.id = owner_id
              )
          ),
          ensure_owner_rows AS (
            INSERT INTO ${this.queueName}_owner_concurrency (id, max_concurrency)
            SELECT owner_id, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(owner_id)
            FROM missing_owners
            ON CONFLICT (id) DO NOTHING
          ),
          updated AS (
            UPDATE ${this.queueName} q
            SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
            WHERE q.status = 'queued'::nuq.job_status AND q.id IN (SELECT id FROM selected_jobs_with_metadata)
            RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")}
          )
          SELECT ${this.jobReturning.map(x => `updated.${x}`).join(", ")} FROM updated;
        `;
      } else if (this.options.concurrencyLimit === "per-owner-per-group") {
        updateQuery = `
          WITH owner_active_counts AS (
            SELECT
              owner_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
            GROUP BY owner_id
          ),
          group_active_counts AS (
            SELECT
              group_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND group_id IS NOT NULL
            GROUP BY group_id
          ),
          group_limited_jobs AS (
            SELECT
              q.id,
              q.owner_id,
              q.group_id,
              q.priority,
              q.created_at,
              ROW_NUMBER() OVER (
                PARTITION BY q.owner_id, q.group_id
                ORDER BY q.priority ASC, q.created_at ASC, q.id ASC
              ) as group_rank,
              GREATEST(
                COALESCE(gc.max_concurrency, 999999)
                - COALESCE(gac.active_count, 0),
                0
              ) as group_limit
            FROM ${this.queueName} q
            LEFT JOIN ${this.queueName}_group_concurrency gc ON gc.id = q.group_id
            LEFT JOIN group_active_counts gac ON gac.group_id = q.group_id
            WHERE q.status = 'queued'::nuq.job_status
          ),
          owner_limited_jobs AS (
            SELECT
              glj.id,
              glj.owner_id,
              glj.group_id,
              ROW_NUMBER() OVER (
                PARTITION BY glj.owner_id
                ORDER BY glj.priority ASC, glj.created_at ASC, glj.id ASC
              ) as owner_rank,
              GREATEST(
                COALESCE(oc.max_concurrency, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(glj.owner_id))
                - COALESCE(oac.active_count, 0),
                0
              ) as owner_limit
            FROM group_limited_jobs glj
            LEFT JOIN ${this.queueName}_owner_concurrency oc ON oc.id = glj.owner_id
            LEFT JOIN owner_active_counts oac ON oac.owner_id = glj.owner_id
            WHERE glj.group_rank <= glj.group_limit
          ),
          selected_jobs_with_metadata AS (
            SELECT id, owner_id, group_id
            FROM owner_limited_jobs
            WHERE owner_rank <= owner_limit
          ),
          missing_owners AS (
            SELECT DISTINCT owner_id
            FROM selected_jobs_with_metadata
            WHERE owner_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_owner_concurrency oc
                WHERE oc.id = owner_id
              )
          ),
          ensure_owner_rows AS (
            INSERT INTO ${this.queueName}_owner_concurrency (id, max_concurrency)
            SELECT owner_id, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(owner_id)
            FROM missing_owners
            ON CONFLICT (id) DO NOTHING
          ),
          missing_groups AS (
            SELECT DISTINCT group_id
            FROM selected_jobs_with_metadata
            WHERE group_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_group_concurrency gc
                WHERE gc.id = group_id
              )
          ),
          ensure_group_rows AS (
            INSERT INTO ${this.queueName}_group_concurrency (id, max_concurrency)
            SELECT group_id, NULL
            FROM missing_groups
            ON CONFLICT (id) DO NOTHING
          ),
          updated AS (
            UPDATE ${this.queueName} q
            SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
            WHERE q.status = 'queued'::nuq.job_status AND q.id IN (SELECT id FROM selected_jobs_with_metadata)
            RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")}
          )
          SELECT ${this.jobReturning.map(x => `updated.${x}`).join(", ")} FROM updated;
        `;
      } else {
        updateQuery = `
          WITH selected_jobs AS (
            SELECT j.id
            FROM ${this.queueName} j
            WHERE j.status = 'queued'::nuq.job_status
            ORDER BY j.priority ASC, j.created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 100
          )
          UPDATE ${this.queueName} q
          SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
          WHERE q.id IN (SELECT id FROM selected_jobs)
          RETURNING ${this.jobReturning.join(", ")};
        `;
      }

      const result = await nuqPool.query(updateQuery);

      const jobs = result.rows.map(row => this.rowToJob(row)!);

      for (const job of jobs) {
        await this.sendJobPrefetch(
          job,
          _logger.child({
            jobId: job.id,
            zeroDataRetention: !!(job.data || ({} as any)).zeroDataRetention,
          }),
        );
      }

      _logger.info("Prefetched jobs", {
        module: "nuq/metrics",
        jobCount: jobs.length,
      });

      return jobs.length;
    } finally {
      _logger.info("nuqPrefetchJobs metrics", {
        module: "nuq/metrics",
        method: "nuqPrefetchJobs",
        duration: Date.now() - start,
      });
    }
  }

  // === Consumer

  public async getJobToProcess(): Promise<NuQJob<any, any> | null> {
    const start = Date.now();
    try {
      if (process.env.NUQ_RABBITMQ_URL) {
        await this.startSender();

        if (this.sender) {
          const job = await this.sender.channel.get(
            this.queueName + ".prefetch",
            { noAck: true },
          );
          if (job !== false) {
            return this.rowToJob(JSON.parse(job.content.toString()));
          } else {
            return null;
          }
        } else {
          logger.warn("NuQ sender not started, falling back to postgres", {
            module: "nuq/rabbitmq",
          });
        }
      }

      let updateQuery: string;
      if (this.options.concurrencyLimit === "per-owner") {
        updateQuery = `
          WITH owner_active_counts AS (
            SELECT
              owner_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
            GROUP BY owner_id
          ),
          owner_limited_jobs AS (
            SELECT
              q.id,
              q.owner_id,
              ROW_NUMBER() OVER (
                PARTITION BY q.owner_id
                ORDER BY q.priority ASC, q.created_at ASC, q.id ASC
              ) as owner_rank,
              GREATEST(
                COALESCE(oc.max_concurrency, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(q.owner_id))
                - COALESCE(oac.active_count, 0),
                0
              ) as owner_limit
            FROM ${this.queueName} q
            LEFT JOIN ${this.queueName}_owner_concurrency oc ON oc.id = q.owner_id
            LEFT JOIN owner_active_counts oac ON oac.owner_id = q.owner_id
            WHERE q.status = 'queued'::nuq.job_status
          ),
          selected_jobs_with_metadata AS (
            SELECT id, owner_id
            FROM owner_limited_jobs
            WHERE owner_rank <= owner_limit
            LIMIT 1
          ),
          missing_owners AS (
            SELECT DISTINCT owner_id
            FROM selected_jobs_with_metadata
            WHERE owner_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_owner_concurrency oc
                WHERE oc.id = owner_id
              )
          ),
          ensure_owner_rows AS (
            INSERT INTO ${this.queueName}_owner_concurrency (id, max_concurrency)
            SELECT owner_id, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(owner_id)
            FROM missing_owners
            ON CONFLICT (id) DO NOTHING
          ),
          updated AS (
            UPDATE ${this.queueName} q
            SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
            WHERE q.status = 'queued'::nuq.job_status AND q.id IN (SELECT id FROM selected_jobs_with_metadata)
            RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")}
          )
          SELECT ${this.jobReturning.map(x => `updated.${x}`).join(", ")} FROM updated;
        `;
      } else if (this.options.concurrencyLimit === "per-owner-per-group") {
        updateQuery = `
          WITH owner_active_counts AS (
            SELECT
              owner_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
            GROUP BY owner_id
          ),
          group_active_counts AS (
            SELECT
              group_id,
              COUNT(*)::int8 as active_count
            FROM ${this.queueName}
            WHERE status = 'active'::nuq.job_status AND group_id IS NOT NULL
            GROUP BY group_id
          ),
          group_limited_jobs AS (
            SELECT
              q.id,
              q.owner_id,
              q.group_id,
              q.priority,
              q.created_at,
              ROW_NUMBER() OVER (
                PARTITION BY q.owner_id, q.group_id
                ORDER BY q.priority ASC, q.created_at ASC, q.id ASC
              ) as group_rank,
              GREATEST(
                COALESCE(gc.max_concurrency, 999999)
                - COALESCE(gac.active_count, 0),
                0
              ) as group_limit
            FROM ${this.queueName} q
            LEFT JOIN ${this.queueName}_group_concurrency gc ON gc.id = q.group_id
            LEFT JOIN group_active_counts gac ON gac.group_id = q.group_id
            WHERE q.status = 'queued'::nuq.job_status
          ),
          owner_limited_jobs AS (
            SELECT
              glj.id,
              glj.owner_id,
              glj.group_id,
              ROW_NUMBER() OVER (
                PARTITION BY glj.owner_id
                ORDER BY glj.priority ASC, glj.created_at ASC, glj.id ASC
              ) as owner_rank,
              GREATEST(
                COALESCE(oc.max_concurrency, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(glj.owner_id))
                - COALESCE(oac.active_count, 0),
                0
              ) as owner_limit
            FROM group_limited_jobs glj
            LEFT JOIN ${this.queueName}_owner_concurrency oc ON oc.id = glj.owner_id
            LEFT JOIN owner_active_counts oac ON oac.owner_id = glj.owner_id
            WHERE glj.group_rank <= glj.group_limit
          ),
          selected_jobs_with_metadata AS (
            SELECT id, owner_id, group_id
            FROM owner_limited_jobs
            WHERE owner_rank <= owner_limit
            LIMIT 1
          ),
          missing_owners AS (
            SELECT DISTINCT owner_id
            FROM selected_jobs_with_metadata
            WHERE owner_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_owner_concurrency oc
                WHERE oc.id = owner_id
              )
          ),
          ensure_owner_rows AS (
            INSERT INTO ${this.queueName}_owner_concurrency (id, max_concurrency)
            SELECT owner_id, ${this.queueName.replaceAll(".", "_")}_owner_resolve_max_concurrency(owner_id)
            FROM missing_owners
            ON CONFLICT (id) DO NOTHING
          ),
          missing_groups AS (
            SELECT DISTINCT group_id
            FROM selected_jobs_with_metadata
            WHERE group_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${this.queueName}_group_concurrency gc
                WHERE gc.id = group_id
              )
          ),
          ensure_group_rows AS (
            INSERT INTO ${this.queueName}_group_concurrency (id, max_concurrency)
            SELECT group_id, NULL
            FROM missing_groups
            ON CONFLICT (id) DO NOTHING
          ),
          updated AS (
            UPDATE ${this.queueName} q
            SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
            WHERE q.status = 'queued'::nuq.job_status AND q.id IN (SELECT id FROM selected_jobs_with_metadata)
            RETURNING ${this.jobReturning.map(x => `q.${x}`).join(", ")}
          )
          SELECT ${this.jobReturning.map(x => `updated.${x}`).join(", ")} FROM updated;
        `;
      } else {
        updateQuery = `
          WITH selected_jobs AS (
            SELECT j.id
            FROM ${this.queueName} j
            WHERE j.status = 'queued'::nuq.job_status
            ORDER BY j.priority ASC, j.created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE ${this.queueName} q
          SET status = 'active'::nuq.job_status, lock = gen_random_uuid(), locked_at = now()
          WHERE q.id IN (SELECT id FROM selected_jobs)
          RETURNING ${this.jobReturning.join(", ")};
        `;
      }

      return this.rowToJob((await nuqPool.query(updateQuery)).rows[0])!;
    } finally {
      logger.info("nuqGetJobToProcess metrics", {
        module: "nuq/metrics",
        method: "nuqGetJobToProcess",
        duration: Date.now() - start,
      });
    }
  }

  public async renewLock(
    id: string,
    lock: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    const start = Date.now();
    try {
      return (
        (
          await nuqPool.query(
            `UPDATE ${this.queueName} SET locked_at = now() WHERE id = $1 AND lock = $2 AND status = 'active'::nuq.job_status;`,
            [id, lock],
          )
        ).rowCount !== 0
      );
    } finally {
      _logger.info("nuqRenewLock metrics", {
        module: "nuq/metrics",
        method: "nuqRenewLock",
        duration: Date.now() - start,
        scrapeId: id,
      });
    }
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return withSpan("nuq.jobFinish", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
      });

      const start = Date.now();
      try {
        const updateQuery = `UPDATE ${this.queueName} SET status = 'completed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), returnvalue = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`;

        const result = await nuqPool.query(updateQuery, [
          id,
          lock,
          returnvalue,
        ]);

        const success = result.rowCount !== 0;

        if (success) {
          const job = result.rows[0];

          if (job) {
            if (
              this.nuqWaitMode === "listen" &&
              !process.env.NUQ_RABBITMQ_URL
            ) {
              await nuqPool.query(
                `SELECT pg_notify('${this.queueName}', $1);`,
                [job.id + "|completed"],
              );
            } else if (process.env.NUQ_RABBITMQ_URL && job.listen_channel_id) {
              await this.sendJobEnd(
                job.id,
                "completed",
                job.listen_channel_id,
                _logger,
              );
            }
          }
        }

        setSpanAttributes(span, {
          "nuq.job_finished": success,
        });

        return success;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqJobFinish metrics", {
          module: "nuq/metrics",
          method: "nuqJobFinish",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    _logger: Logger = logger,
  ): Promise<boolean> {
    return withSpan("nuq.jobFail", async span => {
      setSpanAttributes(span, {
        "nuq.queue_name": this.queueName,
        "nuq.job_id": id,
        "nuq.failed_reason": failedReason,
      });

      const start = Date.now();
      try {
        const updateQuery = `UPDATE ${this.queueName} SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = $3 WHERE id = $1 AND lock = $2 RETURNING id, listen_channel_id;`;

        const result = await nuqPool.query(updateQuery, [
          id,
          lock,
          failedReason,
        ]);

        const success = result.rowCount !== 0;

        if (success) {
          const job = result.rows[0];

          if (job) {
            if (
              this.nuqWaitMode === "listen" &&
              !process.env.NUQ_RABBITMQ_URL
            ) {
              await nuqPool.query(
                `SELECT pg_notify('${this.queueName}', $1);`,
                [job.id + "|failed"],
              );
            } else if (process.env.NUQ_RABBITMQ_URL && job.listen_channel_id) {
              await this.sendJobEnd(
                job.id,
                "failed",
                job.listen_channel_id,
                _logger,
              );
            }
          }
        }

        setSpanAttributes(span, {
          "nuq.job_failed": success,
        });

        return success;
      } finally {
        const duration = Date.now() - start;
        setSpanAttributes(span, {
          "nuq.duration_ms": duration,
        });
        _logger.info("nuqJobFail metrics", {
          module: "nuq/metrics",
          method: "nuqJobFail",
          duration,
          scrapeId: id,
        });
      }
    });
  }

  public async getOwnerJobCounts(
    ownerId: string,
    _logger: Logger = logger,
  ): Promise<{ active: number; queued: number }> {
    const start = Date.now();
    try {
      const result = await nuqPool.query(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'active'::nuq.job_status THEN 1 ELSE 0 END), 0)::int as active,
          COALESCE(SUM(CASE WHEN status = 'queued'::nuq.job_status THEN 1 ELSE 0 END), 0)::int as queued
        FROM ${this.queueName}
        WHERE owner_id = $1;`,
        [ownerId],
      );

      return {
        active: result.rows[0]?.active ?? 0,
        queued: result.rows[0]?.queued ?? 0,
      };
    } finally {
      _logger.info("nuqGetOwnerJobCounts metrics", {
        module: "nuq/metrics",
        method: "nuqGetOwnerJobCounts",
        duration: Date.now() - start,
        ownerId,
      });
    }
  }

  public async getOwnerConcurrency(
    ownerId: string,
    _logger: Logger = logger,
  ): Promise<{
    currentConcurrency: number;
    maxConcurrency: number;
  } | null> {
    const start = Date.now();
    try {
      const result = await nuqPool.query(
        `SELECT
          (SELECT COUNT(*)::int8 FROM ${this.queueName} WHERE owner_id = $1 AND status = 'active'::nuq.job_status) as current_concurrency,
          max_concurrency
        FROM ${this.queueName}_owner_concurrency
        WHERE id = $1;`,
        [ownerId],
      );

      if (result.rows.length === 0) {
        return null;
      }

      return {
        currentConcurrency: result.rows[0].current_concurrency,
        maxConcurrency: result.rows[0].max_concurrency,
      };
    } finally {
      _logger.info("nuqGetOwnerConcurrency metrics", {
        module: "nuq/metrics",
        method: "nuqGetOwnerConcurrency",
        duration: Date.now() - start,
        ownerId,
      });
    }
  }

  // === Metrics
  public async getMetrics(): Promise<string> {
    const start = Date.now();

    let query: string;
    if (this.options.concurrencyLimit === "per-owner") {
      query = `
        WITH owner_active_counts AS (
          SELECT
            owner_id,
            COUNT(*) as active_count
          FROM ${this.queueName}
          WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
          GROUP BY owner_id
        ),
        owner_status AS (
          SELECT
            oc.id,
            GREATEST(0, oc.max_concurrency - COALESCE(oac.active_count, 0)) as available_slots
          FROM ${this.queueName}_owner_concurrency oc
          LEFT JOIN owner_active_counts oac ON oac.owner_id = oc.id
        ),
        queued_per_owner AS (
          SELECT
            owner_id,
            COUNT(*) as queued_count
          FROM ${this.queueName}
          WHERE status = 'queued'::nuq.job_status AND owner_id IS NOT NULL
          GROUP BY owner_id
        ),
        owner_breakdown AS (
          SELECT
            LEAST(qpo.queued_count, COALESCE(os.available_slots, 999999)) as can_run,
            GREATEST(0, qpo.queued_count - COALESCE(os.available_slots, 999999)) as blocked
          FROM queued_per_owner qpo
          LEFT JOIN owner_status os ON qpo.owner_id = os.id
        ),
        non_queued AS (
          SELECT status::text, COUNT(*) as count
          FROM ${this.queueName}
          WHERE status != 'queued'::nuq.job_status
          GROUP BY status
        ),
        totals AS (
          SELECT
            COALESCE(SUM(can_run), 0) as total_queued,
            COALESCE(SUM(blocked), 0) as total_limited
          FROM owner_breakdown
        )
        SELECT status, count FROM non_queued
        UNION ALL
        SELECT 'queued' as status, total_queued::bigint as count
        FROM totals
        WHERE total_queued > 0
        UNION ALL
        SELECT 'concurrency-limited' as status, total_limited::bigint as count
        FROM totals
        WHERE total_limited > 0
        ORDER BY count DESC;
      `;
    } else if (this.options.concurrencyLimit === "per-owner-per-group") {
      query = `
        WITH owner_active_counts AS (
          SELECT
            owner_id,
            COUNT(*) as active_count
          FROM ${this.queueName}
          WHERE status = 'active'::nuq.job_status AND owner_id IS NOT NULL
          GROUP BY owner_id
        ),
        group_active_counts AS (
          SELECT
            group_id,
            COUNT(*) as active_count
          FROM ${this.queueName}
          WHERE status = 'active'::nuq.job_status AND group_id IS NOT NULL
          GROUP BY group_id
        ),
        owner_status AS (
          SELECT
            oc.id,
            GREATEST(0, oc.max_concurrency - COALESCE(oac.active_count, 0)) as available_slots
          FROM ${this.queueName}_owner_concurrency oc
          LEFT JOIN owner_active_counts oac ON oac.owner_id = oc.id
        ),
        group_status AS (
          SELECT
            gc.id,
            GREATEST(0, gc.max_concurrency - COALESCE(gac.active_count, 0)) as available_slots
          FROM ${this.queueName}_group_concurrency gc
          LEFT JOIN group_active_counts gac ON gac.group_id = gc.id
        ),
        queued_per_owner_group AS (
          SELECT
            owner_id,
            group_id,
            COUNT(*) as queued_count
          FROM ${this.queueName}
          WHERE status = 'queued'::nuq.job_status
          GROUP BY owner_id, group_id
        ),
        group_capacity AS (
          SELECT
            qpog.owner_id,
            qpog.group_id,
            qpog.queued_count,
            LEAST(qpog.queued_count, COALESCE(gs.available_slots, 999999)) as group_can_run,
            GREATEST(0, qpog.queued_count - COALESCE(gs.available_slots, 999999)) as group_blocked
          FROM queued_per_owner_group qpog
          LEFT JOIN group_status gs ON qpog.group_id = gs.id
        ),
        owner_breakdown AS (
          SELECT
            gc.owner_id,
            SUM(gc.group_can_run) as total_demand,
            COALESCE(os.available_slots, 999999) as owner_capacity,
            LEAST(SUM(gc.group_can_run), COALESCE(os.available_slots, 999999)) as owner_can_run,
            GREATEST(0, SUM(gc.group_can_run) - COALESCE(os.available_slots, 999999)) as owner_blocked,
            SUM(gc.group_blocked) as group_blocked
          FROM group_capacity gc
          LEFT JOIN owner_status os ON gc.owner_id = os.id
          GROUP BY gc.owner_id, os.available_slots
        ),
        non_queued AS (
          SELECT status::text, COUNT(*) as count
          FROM ${this.queueName}
          WHERE status != 'queued'::nuq.job_status
          GROUP BY status
        ),
        totals AS (
          SELECT
            COALESCE(SUM(owner_can_run), 0) as total_queued,
            COALESCE(SUM(owner_blocked + group_blocked), 0) as total_limited
          FROM owner_breakdown
        )
        SELECT status, count FROM non_queued
        UNION ALL
        SELECT 'queued' as status, total_queued::bigint as count
        FROM totals
        WHERE total_queued > 0
        UNION ALL
        SELECT 'concurrency-limited' as status, total_limited::bigint as count
        FROM totals
        WHERE total_limited > 0
        ORDER BY count DESC;
      `;
    } else {
      query = `SELECT status, COUNT(id) as count FROM ${this.queueName} GROUP BY status ORDER BY count DESC;`;
    }

    const result = await nuqPool.query(query);

    logger.info("nuqGetMetrics metrics", {
      module: "nuq/metrics",
      method: "nuqGetMetrics",
      duration: Date.now() - start,
    });
    const prometheusQueueName = this.queueName.replace(".", "_");
    return `# HELP ${prometheusQueueName}_job_count Number of jobs in each status\n# TYPE ${prometheusQueueName}_job_count gauge\n${result.rows.map(x => `${prometheusQueueName}_job_count{status="${x.status}"} ${x.count}`).join("\n")}\n`;
  }

  // === Cleanup
  public async shutdown() {
    this.shuttingDown = true;
    if (this.listener) {
      const nl = this.listener;
      this.listener = null;
      this.listens = {};
      if (nl.type === "postgres") {
        await nl.client.query(`UNLISTEN "${this.queueName}";`);
        await nl.client.end();
      } else {
        await nl.channel.cancel(nl.queue);
        await nl.channel.close();
        await nl.connection.close();
      }
    }
    if (this.sender) {
      const ns = this.sender;
      this.sender = null;
      await ns.channel.close();
      await ns.connection.close();
    }
  }
}

// === Group

type NuQGroupOptions = {
  memberQueues: NuQ[];
  finishQueue?: NuQ;
  groupTTL: number;
};

type NuQGroupConcurrencySettings = {
  queue: NuQ;
  maxConcurrency?: number;
};

type NuQGroupInstanceOptions = {
  concurrency: NuQGroupConcurrencySettings[];
  ownerId: string;
};

type NuQGroupInstance = {
  id: string;
  status: "active" | "completed";
  createdAt: Date;
  finishedAt?: Date;
  expiresAt?: Date;
  ownerId?: string;
};

class NuQGroup {
  constructor(
    public readonly groupName: string,
    public readonly options: NuQGroupOptions,
  ) {}

  private groupReturning = [
    "id",
    "status",
    "created_at",
    "finished_at",
    "expires_at",
    "owner_id",
  ];

  private rowToGroup(row: any): NuQGroupInstance | null {
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      createdAt: new Date(row.created_at),
      finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      ownerId: row.owner_id ?? undefined,
    };
  }

  public async addGroup(
    id: string,
    options: NuQGroupInstanceOptions,
  ): Promise<NuQGroupInstance> {
    const client = await nuqPool.connect();

    await client.query("BEGIN");

    try {
      const insert = await client.query(
        `INSERT INTO ${this.groupName} (id, owner_id) VALUES ($1, $2) RETURNING ${this.groupReturning.join(", ")};`,
        [id, normalizeOwnerId(options.ownerId) ?? null],
      );

      for (const entry of options.concurrency) {
        if (entry.queue.options.concurrencyLimit === "per-owner-per-group") {
          await client.query(
            `INSERT INTO ${entry.queue.queueName}_group_concurrency (id, max_concurrency) VALUES ($1, $2);`,
            [id, entry.maxConcurrency ?? null],
          );
        }
      }

      await client.query("COMMIT");
      client.release();

      return this.rowToGroup(insert.rows[0])!;
    } catch (e) {
      await client.query("ROLLBACK");
      client.release(e);
      throw e;
    }
  }

  public async getGroup(id: string): Promise<NuQGroupInstance | null> {
    return this.rowToGroup(
      (
        await nuqPool.query(
          `SELECT ${this.groupReturning.join(", ")} FROM ${this.groupName} WHERE id = $1 LIMIT 1;`,
          [id],
        )
      ).rows[0],
    );
  }

  public async cancelGroup(id: string): Promise<boolean> {
    const client = await nuqPool.connect();

    await client.query("BEGIN");

    try {
      const updateOp = await client.query(
        `UPDATE ${this.groupName} SET status = 'cancelled'::nuq.group_status WHERE id = $1 AND status = 'active'::nuq.group_status`,
        [id],
      );

      if (updateOp.rowCount === 0) {
        client.release();
        return false;
      }

      for (const queue of this.options.memberQueues) {
        await client.query(
          `UPDATE ${queue.queueName} SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, finished_at = now(), failedreason = 'CANCELLED' WHERE group_id = $1 AND status = 'queued'::nuq.job_status`,
          [id],
        );
      }

      client.release();
      return true;
    } catch (e) {
      client.release(e);
      throw e;
    }
  }
}

// === Utilities

export function nuqGetLocalMetrics(): string {
  return `# HELP nuq_pool_waiting_count Number of requests waiting in the pool\n# TYPE nuq_pool_waiting_count gauge\nnuq_pool_waiting_count ${nuqPool.waitingCount}\n
# HELP nuq_pool_idle_count Number of connections idle in the pool\n# TYPE nuq_pool_idle_count gauge\nnuq_pool_idle_count ${nuqPool.idleCount}\n
# HELP nuq_pool_total_count Number of connections in the pool\n# TYPE nuq_pool_total_count gauge\nnuq_pool_total_count ${nuqPool.totalCount}\n`;
}

export async function nuqHealthCheck(): Promise<boolean> {
  const start = Date.now();
  try {
    return (await nuqPool.query("SELECT 1;")).rowCount !== 0;
  } finally {
    logger.info("nuqHealthCheck metrics", {
      module: "nuq/metrics",
      method: "nuqHealthCheck",
      duration: Date.now() - start,
    });
  }
}

// === Instances

export const scrapeQueue = new NuQ<ScrapeJobData>("nuq.queue_scrape", {
  concurrencyLimit: "per-owner-per-group",
});
// export const crawlFinishQueue = new NuQ("nuq.queue_crawl_finish");

export const crawlGroup = new NuQGroup("nuq.group_crawl", {
  memberQueues: [scrapeQueue],
  // finishQueue: crawlFinishQueue,
  groupTTL: 24 * 60 * 60,
});

// === Cleanup

export async function nuqShutdown() {
  await scrapeQueue.shutdown();
  await nuqPool.end();
}

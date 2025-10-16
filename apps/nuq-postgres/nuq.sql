CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE SCHEMA IF NOT EXISTS nuq;

DO $$ BEGIN
  CREATE TYPE nuq.job_status AS ENUM ('queued', 'active', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS nuq.queue_scrape (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  status nuq.job_status NOT NULL DEFAULT 'queued'::nuq.job_status,
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  priority int NOT NULL DEFAULT 0,
  lock uuid,
  locked_at timestamp with time zone,
  stalls integer,
  finished_at timestamp with time zone,
  listen_channel_id text, -- for listenable jobs over rabbitmq
  returnvalue jsonb, -- only for selfhost
  failedreason text, -- only for selfhost
  owner_id uuid,
  CONSTRAINT queue_scrape_pkey PRIMARY KEY (id)
);

ALTER TABLE nuq.queue_scrape
SET (autovacuum_vacuum_scale_factor = 0.01,
     autovacuum_analyze_scale_factor = 0.01,
     autovacuum_vacuum_cost_limit = 2000,
     autovacuum_vacuum_cost_delay = 2);

CREATE INDEX IF NOT EXISTS queue_scrape_active_locked_at_idx ON nuq.queue_scrape USING btree (locked_at) WHERE (status = 'active'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_optimal_2_idx ON nuq.queue_scrape (priority ASC, created_at ASC, id) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_failed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'failed'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_completed_created_at_idx ON nuq.queue_scrape USING btree (created_at) WHERE (status = 'completed'::nuq.job_status);

CREATE TABLE IF NOT EXISTS nuq.queue_scrape_owner_concurrency (
    id uuid NOT NULL,
    current_concurrency int8 NOT NULL,
    max_concurrency int8 NOT NULL,
    CONSTRAINT queue_scrape_owner_concurrency_pkey PRIMARY KEY (id)
);

-- fake concurrency limit source for tests
CREATE TABLE IF NOT EXISTS nuq.queue_scrape_owner_concurrency_source (
    id uuid NOT NULL,
    max_concurrency int8 NOT NULL,
    CONSTRAINT queue_scrape_owner_concurrency_source_pkey PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION nuq_queue_scrape_owner_resolve_max_concurrency(owner_id uuid)
RETURNS int8
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((SELECT max_concurrency FROM nuq.queue_scrape_owner_concurrency_source WHERE id = owner_id LIMIT 1), 100)::int8;
$$;

SELECT cron.schedule('nuq_queue_scrape_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'completed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '1 hour';
$$);

SELECT cron.schedule('nuq_queue_scrape_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'failed'::nuq.job_status AND nuq.queue_scrape.created_at < now() - interval '6 hours';
$$);

SELECT cron.schedule('nuq_queue_scrape_lock_reaper', '15 seconds', $$
  WITH requeued AS (
    UPDATE nuq.queue_scrape
    SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1
    WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute'
      AND nuq.queue_scrape.status = 'active'::nuq.job_status
      AND COALESCE(nuq.queue_scrape.stalls, 0) < 9
    RETURNING id, owner_id
  ),
  requeued_counts AS (
    SELECT owner_id, COUNT(*) as job_count
    FROM requeued
    WHERE owner_id IS NOT NULL
    GROUP BY owner_id
  ),
  requeue_concurrency_update AS (
    UPDATE nuq.queue_scrape_owner_concurrency
    SET current_concurrency = GREATEST(0, current_concurrency - requeued_counts.job_count)
    FROM requeued_counts
    WHERE nuq.queue_scrape_owner_concurrency.id = requeued_counts.owner_id
  ),
  stallfail AS (
    UPDATE nuq.queue_scrape
    SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1
    WHERE nuq.queue_scrape.locked_at <= now() - interval '1 minute'
      AND nuq.queue_scrape.status = 'active'::nuq.job_status
      AND COALESCE(nuq.queue_scrape.stalls, 0) >= 9
    RETURNING id, owner_id
  ),
  stallfail_counts AS (
    SELECT owner_id, COUNT(*) as job_count
    FROM stallfail
    WHERE owner_id IS NOT NULL
    GROUP BY owner_id
  ),
  stallfail_concurrency_update AS (
    UPDATE nuq.queue_scrape_owner_concurrency
    SET current_concurrency = GREATEST(0, current_concurrency - stallfail_counts.job_count)
    FROM stallfail_counts
    WHERE nuq.queue_scrape_owner_concurrency.id = stallfail_counts.owner_id
  )
  SELECT pg_notify('nuq.queue_scrape', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_scrape_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_scrape;
$$);

SELECT cron.schedule('nuq_queue_scrape_concurrency_sync', '*/5 * * * *', $$
  WITH actual_concurrency AS (
    SELECT owner_id, COUNT(*) as active_count
    FROM nuq.queue_scrape
    WHERE status = 'active'::nuq.job_status
      AND owner_id IS NOT NULL
    GROUP BY owner_id
  )
  UPDATE nuq.queue_scrape_owner_concurrency
  SET current_concurrency = COALESCE(actual_concurrency.active_count, 0)
  FROM actual_concurrency
  WHERE nuq.queue_scrape_owner_concurrency.id = actual_concurrency.owner_id
    AND nuq.queue_scrape_owner_concurrency.current_concurrency != COALESCE(actual_concurrency.active_count, 0);

  UPDATE nuq.queue_scrape_owner_concurrency
  SET current_concurrency = 0
  WHERE current_concurrency > 0
    AND NOT EXISTS (
      SELECT 1 FROM nuq.queue_scrape
      WHERE nuq.queue_scrape.owner_id = nuq.queue_scrape_owner_concurrency.id
        AND nuq.queue_scrape.status = 'active'::nuq.job_status
    );

  UPDATE nuq.queue_scrape_owner_concurrency
    SET max_concurrency = (SELECT nuq_queue_scrape_owner_resolve_max_concurrency(nuq.queue_scrape_owner_concurrency.id));
$$);

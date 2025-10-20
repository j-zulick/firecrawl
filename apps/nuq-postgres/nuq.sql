CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE SCHEMA IF NOT EXISTS nuq;

DO $$ BEGIN
  CREATE TYPE nuq.job_status AS ENUM ('queued', 'active', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE nuq.group_status AS ENUM ('active', 'completed', 'cancelled');
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
  group_id uuid,
  times_out_at timestamp with time zone,
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
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_owner_idx ON nuq.queue_scrape (owner_id, priority ASC, created_at ASC) WHERE (status = 'queued'::nuq.job_status);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_owner_group_idx ON nuq.queue_scrape (owner_id, group_id, priority ASC, created_at ASC) WHERE (status = 'queued'::nuq.job_status);

-- Performance indexes for prefetchJobs query optimization
-- This index dramatically speeds up the "SELECT DISTINCT owner_id, group_id" query in the queued_combinations CTE
-- by allowing an index-only scan instead of a sequential scan of all queued jobs
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_owner_group_distinct_idx ON nuq.queue_scrape (owner_id, group_id) WHERE (status = 'queued'::nuq.job_status);

-- This index helps with group-specific queries and provides better coverage for per-group capacity lookups
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_group_priority_idx ON nuq.queue_scrape (group_id, priority ASC, created_at ASC) WHERE (status = 'queued'::nuq.job_status AND group_id IS NOT NULL);

-- This index helps with owner-specific queries when group_id is NULL
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_owner_no_group_idx ON nuq.queue_scrape (owner_id, priority ASC, created_at ASC) WHERE (status = 'queued'::nuq.job_status AND group_id IS NULL);

CREATE INDEX IF NOT EXISTS nuq_queue_scrape_queued_complete_idx ON nuq.queue_scrape (owner_id, group_id, priority ASC, created_at ASC, id ASC) WHERE (status = 'queued'::nuq.job_status);

-- Indexes for dynamic concurrency counting (replacing current_concurrency counters)
-- This allows fast COUNT(*) queries for active jobs per owner/group without maintaining counters
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_active_owner_idx ON nuq.queue_scrape (owner_id) WHERE (status = 'active'::nuq.job_status AND owner_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS nuq_queue_scrape_active_group_idx ON nuq.queue_scrape (group_id) WHERE (status = 'active'::nuq.job_status AND group_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS nuq.queue_scrape_owner_concurrency (
    id uuid NOT NULL,
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

CREATE TABLE IF NOT EXISTS nuq.queue_scrape_group_concurrency (
    id uuid NOT NULL,
    max_concurrency int8,
    CONSTRAINT queue_scrape_group_concurrency_pkey PRIMARY KEY (id)
);

SELECT cron.schedule('nuq_queue_scrape_clean_completed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'completed'::nuq.job_status AND nuq.queue_scrape.group_id IS NULL AND nuq.queue_scrape.created_at < now() - interval '1 hour';
$$);

SELECT cron.schedule('nuq_queue_scrape_clean_failed', '*/5 * * * *', $$
  DELETE FROM nuq.queue_scrape WHERE nuq.queue_scrape.status = 'failed'::nuq.job_status AND nuq.queue_scrape.group_id IS NULL AND nuq.queue_scrape.created_at < now() - interval '6 hours';
$$);

SELECT cron.schedule('nuq_queue_scrape_lock_reaper', '15 seconds', $$
  WITH stalled_jobs AS (
    SELECT id, owner_id, group_id, stalls
    FROM nuq.queue_scrape
    WHERE locked_at <= now() - interval '1 minute'
      AND status = 'active'::nuq.job_status
  ),
  requeued AS (
    UPDATE nuq.queue_scrape
    SET status = 'queued'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1
    WHERE id IN (
      SELECT sj.id
      FROM stalled_jobs sj
      WHERE COALESCE(sj.stalls, 0) < 9
    )
    RETURNING id
  ),
  stallfail AS (
    UPDATE nuq.queue_scrape
    SET status = 'failed'::nuq.job_status, lock = null, locked_at = null, stalls = COALESCE(stalls, 0) + 1
    WHERE id IN (
      SELECT sj.id
      FROM stalled_jobs sj
      WHERE COALESCE(sj.stalls, 0) >= 9
    )
    RETURNING id
  )
  SELECT pg_notify('nuq.queue_scrape', (id::text || '|' || 'failed'::text)) FROM stallfail;
$$);

SELECT cron.schedule('nuq_queue_scrape_reindex', '0 9 * * *', $$
  REINDEX TABLE CONCURRENTLY nuq.queue_scrape;
$$);

SELECT cron.schedule('nuq_queue_scrape_max_concurrency_sync', '*/5 * * * *', $$
  UPDATE nuq.queue_scrape_owner_concurrency
    SET max_concurrency = (SELECT nuq_queue_scrape_owner_resolve_max_concurrency(nuq.queue_scrape_owner_concurrency.id));
$$);

SELECT cron.schedule('nuq_queue_scrape_timeout', '* * * * *', $$
  UPDATE nuq.queue_scrape
  SET status = 'failed', finished_at = now(), failedreason = 'SCRAPE_TIMEOUT|{"stack":"Error: Scrape timed out\n    in DB","message":"Scrape timed out"}'
  WHERE status = 'queued' AND times_out_at < now();
$$);

CREATE TABLE IF NOT EXISTS nuq.group_crawl (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    status nuq.group_status NOT NULL DEFAULT 'active'::nuq.group_status,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    finished_at timestamp with time zone,
    expires_at timestamp with time zone,
    owner_id uuid,
    CONSTRAINT group_crawl_pkey PRIMARY KEY (id)
);

CREATE OR REPLACE FUNCTION nuq_queue_scrape_check_group_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.group_id IS NOT NULL THEN
    UPDATE nuq.group_crawl
    SET status = 'completed'::nuq.group_status,
        finished_at = now(),
        expires_at = now() + interval '24 hours'
    WHERE id = NEW.group_id
      AND status != 'completed'::nuq.group_status
      AND NOT EXISTS (
        SELECT 1
        FROM nuq.queue_scrape
        WHERE group_id = NEW.group_id
          AND status NOT IN ('completed'::nuq.job_status, 'failed'::nuq.job_status)
      );
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger to automatically mark groups as completed
CREATE OR REPLACE TRIGGER nuq_queue_scrape_group_completion_trigger
AFTER UPDATE OF status ON nuq.queue_scrape
FOR EACH ROW
WHEN (NEW.status IN ('completed'::nuq.job_status, 'failed'::nuq.job_status)
  AND OLD.status NOT IN ('completed'::nuq.job_status, 'failed'::nuq.job_status))
EXECUTE FUNCTION nuq_queue_scrape_check_group_completion();

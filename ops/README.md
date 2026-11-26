# Operating a self-hosted Firecrawl renderer

A browser crash or a surge of rendering jobs can consume the memory needed by search and the research gateway. This fork runs the renderer on a separate host. Concurrent scrape requests share one Chromium relaunch after a crash. The sandbox sizing run below explains the two-worker default. [Component diagram and request path](ARCHITECTURE.md)

## What the fork changes on top of upstream

| Area | Change |
|---|---|
| `docker-compose.yaml` | External Redis (`REDIS_URL` required); `POSTGRES_PASSWORD` required; API published on `127.0.0.1` only; `restart: unless-stopped` + rotated logs everywhere; healthchecks for api and playwright; memory/CPU limits and `NUQ_WORKER_COUNT=2` sized for a 4 GB host; bundled Redis and FoundationDB moved behind profiles (`bundled-redis`, `fdb`). |
| `apps/playwright-service-ts` | Relaunches Chromium if it dies, single-flight so concurrent requests share one relaunch. |
| `apps/api` `/map` | Self-hosted link discovery: without fire-engine, `/map` returned nothing for sites with no sitemap. It now adds links from the start page (plus up to 2 more same-site pages) and a SearXNG `site:` query when `SEARXNG_ENDPOINT` is set. Knobs: `MAP_SELFHOST_DISCOVERY` (default `true`), `MAP_SELFHOST_DISCOVERY_MAX_PAGES` (default `3`). |
| `ops/selfhost-smoke.sh` | End-to-end smoke test of a deployment. |

## Komodo environment

Required:

- `REDIS_URL`: the existing external Redis (unchanged).
- `POSTGRES_PASSWORD`: **new.** Password for the `nuq-postgres` queue database.
  It never leaves the compose network; any long random value works. Compose
  refuses to start without it.

Optional sizing knobs (defaults are for the 4 GB droplet):

| Variable | Default | Notes |
|---|---|---|
| `NUQ_WORKER_COUNT` | 2 | Scrape worker processes (~280 MB each). Upstream default 5. |
| `API_MEM_LIMIT` | 2304m | API container runs api + workers in one container. |
| `PLAYWRIGHT_MEM_LIMIT` | 1536m | |
| `PLAYWRIGHT_MAX_CONCURRENT_PAGES` | 4 | Concurrent pages in the shared Chromium. |
| `POSTGRES_MEM_LIMIT` / `RABBITMQ_MEM_LIMIT` | 512m / 384m | |
| `MAX_CPU` / `MAX_RAM` | 0.85 | Workers stop pulling jobs above these fractions. |

On an 8 GB droplet, `NUQ_WORKER_COUNT=4`, `API_MEM_LIMIT=4g`,
`PLAYWRIGHT_MAX_CONCURRENT_PAGES=8` is a reasonable step up.

## Measured footprint (sandbox, 2026-11-18, `upstream-sync` branch)

| | Idle | 40-page crawl peak |
|---|---|---|
| api (api + 2 nuq workers + extract/queue/prefetch/reconciler) | 1.41 GiB (1.75 GiB during startup) | 1.65 GiB |
| playwright-service | 0.21 GiB | 0.32 GiB |
| rabbitmq | 0.12 GiB | 0.14 GiB |
| nuq-postgres | 0.11 GiB | 0.10 GiB |
| **Total** | **~1.85 GiB** | **~2.2 GiB** |

At 1600 MB the API container was OOM-killed during startup; 2304 MB leaves ~0.6 GB headroom.

## Upgrading from the Aug-2025 base (first deploy of `upstream-sync`)

The upstream architecture changed between the old base and now:

- There is **no separate `worker` container**. The `api` container runs a
  harness that starts the API and all workers as child processes.
- Jobs go through **NuQ**: two new containers, `rabbitmq` and `nuq-postgres`.
  Redis is still used (rate limits, caches, crawl state).
- `/v1/*` endpoints are kept, and `/v2/*` is the current API. The smoke test
  covers both.

### Build and verify an isolated deployment

1. Record the current Git revision, Compose project name, image IDs and queue database backup before an upgrade. Use a separate test project with its own database, cache, volumes and available loopback port. Put the required settings in that project's environment.
2. Check out the candidate revision in the stack's build directory. If Komodo's stack has builds disabled, run `docker compose build api playwright-service` there **using the configured project name**, then run DeployStack. Check both the revision Komodo reports and the image IDs of the actual running containers. A successful deployment can still be serving an older local image.
3. From the checkout, run the smoke script against the isolated instance with Bash, curl and jq. The checked-in Compose default port is 3002. The script submits a two-page crawl and a two-URL batch to a scraper-test site. It checks v1 and v2 scrape responses, map results, completed jobs and rejection of an invalid URL. Set `SMOKE_SEARCH=1` only for an instance with search configured.

   ```sh
   git rev-parse HEAD
   docker compose ps
   bash ops/selfhost-smoke.sh http://127.0.0.1:3002
   ```

   On a Linux host without jq, a disposable test client can use the same loopback endpoint:

   ```sh
   docker run --rm --network host -v "$PWD/ops/selfhost-smoke.sh:/smoke.sh:ro" alpine:3 \
     sh -c 'apk add -q --no-cache bash curl jq >/dev/null && bash /smoke.sh http://127.0.0.1:3002'
   ```

   Keep the revision, image IDs, timestamp, outcomes and final exit status in the deployment record. Redact identifiers before sharing. A green fork CI build covers configuration, shell checks and component tests. The deployed service needs its own successful smoke run.
4. Inspect the previous topology for orphaned worker containers. Stop only a positively identified obsolete worker after confirming that its queue has drained and the replacement passed its checks.

### Rollback

Restore the last verified checkout and corresponding images, then redeploy using the same Compose project, existing queue data and compatible configuration. Verify database compatibility before switching between queue architectures. Repeat the version, container and smoke checks. Preserve the failed deployment record for diagnosis.

## Building locally

From a clean checkout, use a fresh Compose project and an unused host port. This shell sets temporary development values for the bundled Redis and the new database:

```sh
export COMPOSE_PROJECT_NAME=firecrawl-sandbox
export REDIS_URL=redis://redis:6379
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export PORT=3303
docker compose --profile bundled-redis up --build -d
bash ops/selfhost-smoke.sh "http://127.0.0.1:$PORT"
```

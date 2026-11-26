# j-zulick fork: operator notes

This fork tracks [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) and is
deployed by Komodo (stack `firecrawl-stack`) to **firecrawl-node** (DigitalOcean
droplet,2 vCPU / 4 GB). Komodo builds from `main`, so
**merging to `main` and running DeployStack is a production deploy.**

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

Steps (all on **firecrawl-node**, prompt `<user>@firecrawl-node`; host key
`SHA256:IHvBmZ…a1rDo`):

1. Add `POSTGRES_PASSWORD` to the Komodo stack environment.
2. Merge the PR to `main`, build the changed images from Komodo's checkout, then run
   **DeployStack** in Komodo. DeployStack does not build (the stack has `run_build: false`):
   without the build step the new compose runs the old images. The `api` build takes about
   10–15 minutes (Rust + Go + pnpm). Build with placeholder values; Komodo supplies the real
   environment at DeployStack:
   ```bash
   docker exec periphery sh -c 'cd /etc/komodo/stacks/firecrawl-stack && \
     REDIS_URL=redis://build-only POSTGRES_PASSWORD=build-only \
     docker compose -p firecrawl-stack -f docker-compose.yaml build api playwright-service'
   ```
   After DeployStack, check that the running images are the new ones
   (`docker image inspect firecrawl-stack-api --format '{{.Created}}'` is after the merge)
   and that Komodo's deployed commit matches `main`.
3. Remove the old worker container, which Compose no longer manages. If it is left
   running, it keeps the old code and old image:
   ```bash
   docker ps -a --filter name=firecrawl-stack-worker --format '{{.Names}} {{.Status}}'
   docker rm -f firecrawl-stack-worker-1   # name as printed above
   ```
4. Wait for `docker ps` to show `api` and `playwright-service` as `(healthy)`,
   then run the smoke test on the host. The API is published on
   `127.0.0.1:3302` on firecrawl-node (`PORT` in the Komodo env). The script
   needs `bash`, `curl` and `jq`. The host has no `jq`, so run it in a throwaway
   container on the host network:
   ```bash
   docker exec periphery cat /etc/komodo/stacks/firecrawl-stack/ops/selfhost-smoke.sh > /tmp/fc-smoke.sh
   docker run --rm --network host -v /tmp/fc-smoke.sh:/s.sh:ro alpine:3 \
     sh -c 'apk add -q --no-cache bash curl jq >/dev/null && bash /s.sh http://127.0.0.1:3302'
   rm -f /tmp/fc-smoke.sh
   ```
   Record the commit (`docker exec periphery git -C /etc/komodo/stacks/firecrawl-stack log -1 --format=%h`)
   with the PASS/FAIL lines and the date.
   To test through nginx instead, run
   `FIRECRAWL_TOKEN=<nginx bearer> bash /tmp/fc-smoke.sh https://firecrawl.example.com`.
   Add `SMOKE_SEARCH=1` if `SEARXNG_ENDPOINT` is configured.
5. Update the health check script (`private/komodo/firecrawl-health.sh`). It should
   expect `api`, `playwright-service`, `rabbitmq` and `nuq-postgres`, and no
   longer `worker`.

### Rollback

1. In Komodo, point the stack at commit `379d3de` (the last pre-sync `main`), or
   revert the merge commit on `main`, then run DeployStack.
2. Remove the containers the old compose file does not manage:
   `docker rm -f firecrawl-stack-rabbitmq-1 firecrawl-stack-nuq-postgres-1`.
3. Run the health check.

## Building locally

```bash
docker compose build
REDIS_URL=redis://redis:6379 POSTGRES_PASSWORD=dev docker compose --profile bundled-redis up -d
ops/selfhost-smoke.sh
```

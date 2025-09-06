#!/bin/sh
set -eu

# Require auth key
if [ -z "${TS_AUTHKEY:-}" ]; then
  echo "[tailscale-proxy] TS_AUTHKEY is not set; refusing to start." >&2
  exit 1
fi

# Compute hostname: allow override via TS_HOSTNAME, else default to pod name
TS_HOSTNAME=${TS_HOSTNAME:-}
if [ -z "${TS_HOSTNAME}" ]; then
  # Kubernetes sets HOSTNAME to the pod name
  TS_HOSTNAME="firecrawl-proxy-${HOSTNAME:-container}"
fi

# Start tailscaled
tailscaled --state=mem: &

# Wait for tailscaled control socket to be ready (up to ~15s)
i=0
until tailscale version >/dev/null 2>&1 || [ $i -ge 30 ]; do
  i=$((i+1))
  sleep 0.5
done

# Prepare optional flags
ADVERTISE_FLAGS=""
if [ -n "${TS_ADVERTISE_TAGS:-}" ]; then
  ADVERTISE_FLAGS="--advertise-tags=${TS_ADVERTISE_TAGS}"
fi

set -x
tailscale up \
  --authkey="${TS_AUTHKEY}" \
  --hostname="${TS_HOSTNAME}" \
  --accept-routes=true \
  --accept-dns=true \
  --ssh=false \
  ${ADVERTISE_FLAGS} \
  --reset
set +x

# Replace FIRE_ENGINE_BETA_URL in nginx config
sed "s|\$FIRE_ENGINE_BETA_URL|${FIRE_ENGINE_BETA_URL}|g" /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Start nginx
exec nginx -g "daemon off;"
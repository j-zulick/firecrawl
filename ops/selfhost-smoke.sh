#!/usr/bin/env bash
# Smoke test a self-hosted Firecrawl deployment end to end.
#
# Usage:
#   ops/selfhost-smoke.sh [BASE_URL]            # default http://127.0.0.1:3002
#   FIRECRAWL_TOKEN=... ops/selfhost-smoke.sh https://firecrawl.example.com
#   SMOKE_SEARCH=1 ...                          # also test /v2/search (needs SEARXNG_ENDPOINT)
#   SMOKE_URL=https://example.com ...           # page to scrape (default https://books.toscrape.com/, a site built for scraper testing)
#   SMOKE_CURL_OPTS="--cacert /path/ca.crt"     # extra curl options
#
# Read-only against the target site; creates one small crawl (limit 2) and one
# 2-URL batch scrape. Prints PASS/FAIL per check and exits non-zero on any FAIL.
set -uo pipefail

BASE="${1:-http://127.0.0.1:3002}"
BASE="${BASE%/}"
URL="${SMOKE_URL:-https://books.toscrape.com/}"
TOKEN="${FIRECRAWL_TOKEN:-${TEST_API_KEY:-fc-selfhost}}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
read -r -a EXTRA <<< "${SMOKE_CURL_OPTS:-}"

command -v jq >/dev/null || { echo "jq is required"; exit 2; }

fails=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; fails=$((fails + 1)); }

req() { # req METHOD PATH [JSON_BODY]
  local m=$1 p=$2 body=${3:-}
  local args=(-sS -m "$TIMEOUT" -X "$m" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "${EXTRA[@]}")
  [[ -n $body ]] && args+=(-d "$body")
  curl "${args[@]}" -w '\n%{http_code}' "$BASE$p" 2>&1
}
split() { RESP_BODY=$(sed '$d' <<< "$1"); RESP_CODE=$(tail -n1 <<< "$1"); }

# 1. API is up
split "$(req GET /)"
if [[ $RESP_CODE == 200 ]]; then pass "GET / (api up)"; else fail "GET /" "HTTP $RESP_CODE"; fi

# 2. v1 scrape (legacy contract still used by older clients)
split "$(req POST /v1/scrape "{\"url\":\"$URL\",\"formats\":[\"markdown\"]}")"
md=$(jq -r '.data.markdown // empty' <<< "$RESP_BODY" 2>/dev/null)
if [[ $RESP_CODE == 200 && -n $md ]]; then pass "POST /v1/scrape markdown (${#md} chars)"
else fail "POST /v1/scrape" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi

# 3. v2 scrape with markdown + links + rendered (playwright) path
split "$(req POST /v2/scrape "{\"url\":\"$URL\",\"formats\":[\"markdown\",\"links\"],\"waitFor\":500}")"
md=$(jq -r '.data.markdown // empty' <<< "$RESP_BODY" 2>/dev/null)
links=$(jq -r '.data.links | length' <<< "$RESP_BODY" 2>/dev/null)
if [[ $RESP_CODE == 200 && -n $md ]]; then pass "POST /v2/scrape markdown+links (${#md} chars, ${links:-0} links)"
else fail "POST /v2/scrape" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi

# 4. v2 map
split "$(req POST /v2/map "{\"url\":\"$URL\",\"limit\":10}")"
n=$(jq -r '.links | length' <<< "$RESP_BODY" 2>/dev/null)
if [[ $RESP_CODE == 200 && ${n:-0} -ge 1 ]]; then pass "POST /v2/map ($n links)"
else fail "POST /v2/map" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi

poll() { # poll NAME PATH -> waits for status completed
  local name=$1 path=$2 deadline=$((SECONDS + TIMEOUT)) st=""
  while (( SECONDS < deadline )); do
    split "$(req GET "$path")"
    st=$(jq -r '.status // empty' <<< "$RESP_BODY" 2>/dev/null)
    case $st in
      completed) pass "$name completed ($(jq -r '.completed' <<< "$RESP_BODY")/$(jq -r '.total' <<< "$RESP_BODY") pages)"; return;;
      failed|cancelled) fail "$name" "status $st"; return;;
    esac
    sleep 2
  done
  fail "$name" "not completed within ${TIMEOUT}s (last status: ${st:-HTTP $RESP_CODE})"
}

# 5. v2 crawl (exercises the queue: RabbitMQ + nuq-postgres + workers)
split "$(req POST /v2/crawl "{\"url\":\"$URL\",\"limit\":2}")"
id=$(jq -r '.id // empty' <<< "$RESP_BODY" 2>/dev/null)
if [[ -n $id ]]; then poll "v2 crawl $id" "/v2/crawl/$id"; else fail "POST /v2/crawl" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi

# 6. v2 batch scrape
split "$(req POST /v2/batch/scrape "{\"urls\":[\"$URL\",\"${URL%/}/catalogue/page-2.html\"],\"formats\":[\"markdown\"]}")"
id=$(jq -r '.id // empty' <<< "$RESP_BODY" 2>/dev/null)
if [[ -n $id ]]; then poll "v2 batch scrape $id" "/v2/batch/scrape/$id"; else fail "POST /v2/batch/scrape" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi

# 7. optional search (SearXNG)
if [[ ${SMOKE_SEARCH:-0} == 1 ]]; then
  split "$(req POST /v2/search '{"query":"firecrawl web scraper","limit":3}')"
  n=$(jq -r '.data.web | length' <<< "$RESP_BODY" 2>/dev/null)
  if [[ $RESP_CODE == 200 && ${n:-0} -ge 1 ]]; then pass "POST /v2/search ($n results)"
  else fail "POST /v2/search" "HTTP $RESP_CODE $(head -c 300 <<< "$RESP_BODY")"; fi
fi

# 8. failure path: invalid URL must be rejected cleanly (4xx, not 5xx)
split "$(req POST /v2/scrape '{"url":"not a url"}')"
if [[ $RESP_CODE =~ ^4 ]]; then pass "invalid URL rejected (HTTP $RESP_CODE)"; else fail "invalid URL" "expected 4xx, got HTTP $RESP_CODE"; fi

echo
if (( fails == 0 )); then echo "SMOKE OK"; else echo "SMOKE FAILED ($fails check(s))"; exit 1; fi

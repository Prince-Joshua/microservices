#!/usr/bin/env bash
# Follow one request across the gateway and all services.
#   deploy/trace.sh <request-id>            id from the X-Request-Id response header or the web app's "ref"
#   SINCE=1h deploy/trace.sh <request-id>   narrow the window (default 24h)
set -euo pipefail

id="${1:?usage: deploy/trace.sh <request-id>}"
compose="${COMPOSE:-docker compose -f docker-compose.prod.yml}"

$compose logs --no-color --no-log-prefix --since "${SINCE:-24h}" 2>/dev/null \
  | node "$(dirname "$0")/trace.mjs" "$id"

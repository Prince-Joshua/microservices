#!/usr/bin/env bash
# Wake free Render services before a demo or a test (they sleep after 15 idle minutes and
# take up to a minute to start). Run it a minute or two before you need them:
#   deploy/warm-up.sh https://shopfront-users.onrender.com https://shopfront-products.onrender.com \
#                     https://shopfront-orders.onrender.com https://shopfront-payments.onrender.com
set -u
[ $# -gt 0 ] || { echo "usage: $0 <service-url>..."; exit 2; }

for url in "$@"; do
  ( curl -s -o /dev/null --max-time 120 -w "%{http_code}  ${url}  (%{time_total}s)\n" "${url%/}/health" ) &
done
wait

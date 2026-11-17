#!/usr/bin/env bash
# Checks that every site in SITES (a JSON array; "" marks an instance that never launched), and its mail- host, has
# stopped serving, each within WINDOW seconds (default 180).
#
# Only the router's 404 for an unknown test server passes: its lookup found no running instance for the name. A 502
# (the instance is still known but not answering) or 503 (the lookup could not run) is retried, as is a refused or
# timed-out request, since any network fault looks like that. Each request and wait is cut to the time left.
set -euo pipefail

WINDOW=${WINDOW:-180}
INTERVAL=${INTERVAL:-5}
GONE='No test server for this hostname'

sites=$(jq -r '.[] | select(. != "")' <<< "${SITES:-[]}")
if [ -z "$sites" ]; then
  echo "::error::no sites to check"
  exit 1
fi

body=$(mktemp)
trap 'rm -f "$body"' EXIT

failed=0
for site in $sites; do
  site=${site%/}
  scheme=${site%%://*}
  host=${site#*://}
  for url in "${site}/api/v4/system/ping" "${scheme}://mail-${host}/"; do
    gone=0
    code=000
    attempts=0
    start=$SECONDS
    while :; do
      left=$((WINDOW - (SECONDS - start)))
      [ "$left" -gt 0 ] || break
      attempts=$((attempts + 1))
      : > "$body"
      # curl prints 000 itself when no answer came.
      code=$(curl -sS -o "$body" -w '%{http_code}' --max-time "$((left < 15 ? left : 15))" "$url" 2> /dev/null) || true
      if [ "$code" = 404 ] && grep -q "$GONE" "$body"; then
        echo "  gone  ${url} (after ${attempts} attempt(s), $((SECONDS - start))s)"
        gone=1
        break
      fi
      left=$((WINDOW - (SECONDS - start)))
      [ "$left" -gt 0 ] || break
      sleep "$((left < INTERVAL ? left : INTERVAL))"
    done
    if [ "$gone" -ne 1 ]; then
      echo "::error::${url} is still served after $((SECONDS - start))s (${attempts} attempt(s)): last answer ${code} $(head -c 200 "$body" | tr '\n' ' ')"
      failed=1
    fi
  done
done
exit $failed

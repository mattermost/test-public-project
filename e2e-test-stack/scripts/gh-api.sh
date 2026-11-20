#!/usr/bin/env bash
# Runs `gh api` with these arguments, at most 60 seconds an attempt, and up to three more times while it fails with a
# server error (5xx), a timeout or a network error, after 10, 20 and 30 seconds, or a secondary rate limit or a 429,
# after 60 seconds. Any other failure, such as a 404, an auth error, a bad --jq filter or the primary rate limit, which
# resets only on the hour, is final.
#
# Prints only gh's output. Once it gives up it prints every attempt's error on stderr as one line, so a caller can put
# it in an ::error:: command, and exits non-zero.
set -uo pipefail

TRANSIENT='HTTP 5[0-9][0-9]|timed out|timeout|connection (reset|refused)|unexpected EOF|TLS handshake|no such host|i/o'
THROTTLED='HTTP 429|secondary rate limit'

err=$(mktemp)
trap 'rm -f "$err"' EXIT
errors=""

for attempt in 1 2 3 4; do
  rc=0
  out=$(timeout 60 gh api "$@" 2>"$err") || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$out"
    exit 0
  fi
  [ "$rc" -ne 124 ] || echo "gh api did not answer within 60 seconds" >>"$err"
  errors="${errors:+${errors}; }attempt ${attempt}: $(tr '\n' ' ' <"$err" | sed 's/ *$//')"
  [ "$attempt" -lt 4 ] || break
  if [ "$rc" -ne 124 ] && grep -qiE "$THROTTLED" "$err"; then
    sleep 60
  elif [ "$rc" -eq 124 ] || grep -qiE "$TRANSIENT" "$err"; then
    sleep $((attempt * 10))
  else
    break
  fi
done

echo "$errors" >&2
exit 1

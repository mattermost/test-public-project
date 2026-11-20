#!/usr/bin/env bash
# Picks the AWS account a job runs in and its CI role, and writes both to GITHUB_OUTPUT as account= and arn=.
#
# The account is the one recorded in ACCOUNT_FILE when that file exists (a run's create records it beside its
# response), otherwise ACCOUNT: prod or dev. ACCOUNT may also be empty or "recorded", which accepts only a recorded
# account. A recorded account and a prod or dev ACCOUNT that differ fail. The role is ROLE_PROD or ROLE_DEV, the
# repository variables MM_E2E_TEST_STACK_AWS_ROLE_ARN_PROD and _DEV; an unset one fails rather than fall back to the
# other account.
set -euo pipefail

account=${ACCOUNT:-}
[ "$account" != recorded ] || account=""

if [ -n "${ACCOUNT_FILE:-}" ] && [ -f "$ACCOUNT_FILE" ]; then
  recorded=$(cat "$ACCOUNT_FILE")
  case "$recorded" in
    prod | dev) ;;
    *) echo "::error::the recorded account is not prod or dev" >&2; exit 1 ;;
  esac
  if [ -n "$account" ] && [ "$account" != "$recorded" ]; then
    echo "::error::the run recorded account ${recorded}; account ${account} was asked for" >&2
    exit 1
  fi
  account=$recorded
fi

case "$account" in
  prod) arn=${ROLE_PROD:-} var=MM_E2E_TEST_STACK_AWS_ROLE_ARN_PROD ;;
  dev) arn=${ROLE_DEV:-} var=MM_E2E_TEST_STACK_AWS_ROLE_ARN_DEV ;;
  "")
    if [ -n "${ACCOUNT_FILE:-}" ]; then
      echo "::error::the run recorded no account, as runs before the account input did: set account to prod or dev" >&2
    else
      echo "::error::account must be prod or dev" >&2
    fi
    exit 1
    ;;
  *) echo "::error::account must be prod or dev" >&2; exit 1 ;;
esac
if [ -z "$arn" ]; then
  echo "::error::the repository variable ${var} is not set" >&2
  exit 1
fi

echo "account: ${account}"
{
  echo "account=${account}"
  echo "arn=${arn}"
} >> "$GITHUB_OUTPUT"

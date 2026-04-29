#!/usr/bin/env node
// Final report job: mark the report group complete (idempotent on composite
// identity) and write a job summary with the orchestration counts + a link to
// the per-group page. Per-shard report uploads already happened inside each
// worker.

import fs from 'node:fs';

const TEST_SYSTEM_IO_URL = required('TEST_SYSTEM_IO_URL');
const TEST_SYSTEM_IO_BEARER = required('TEST_SYSTEM_IO_BEARER');
const COMPOSITE_IDENTITY = JSON.parse(required('COMPOSITE_IDENTITY'));

const reportsIdent = {
  repository: COMPOSITE_IDENTITY.repository,
  commit: COMPOSITE_IDENTITY.commit_sha,
  gh_run_id: COMPOSITE_IDENTITY.gh_run_id,
  gh_run_attempt: COMPOSITE_IDENTITY.gh_run_attempt,
  framework: 'playwright',
  name: COMPOSITE_IDENTITY.name,
  branch: COMPOSITE_IDENTITY.branch,
};
if (COMPOSITE_IDENTITY.gh_pr_number != null) reportsIdent.gh_pr_number = COMPOSITE_IDENTITY.gh_pr_number;

const completeRes = await fetch(`${TEST_SYSTEM_IO_URL}/api/v1/reports/complete`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_SYSTEM_IO_BEARER}` },
  body: JSON.stringify(reportsIdent),
});
if (completeRes.status !== 200) {
  // Loud failure — the server-side per-report auto-finalize is the safety
  // net for stuck `processing` rows, but a missed /reports/complete still
  // leaves the report_group at `in_progress` until every shard's upload
  // pipeline lands. Surface the error in CI so the next investigation
  // doesn't have to dig through staging API to discover that this step
  // silently dropped the ball.
  const t = await completeRes.text().catch(() => '');
  console.error(`reports/complete returned ${completeRes.status}: ${t}`);
  process.exit(1);
}
console.log('[finalize] reports/complete OK');

const params = new URLSearchParams({
  repository: COMPOSITE_IDENTITY.repository,
  commit_sha: COMPOSITE_IDENTITY.commit_sha,
  gh_run_id: COMPOSITE_IDENTITY.gh_run_id,
  name: COMPOSITE_IDENTITY.name,
  gh_run_attempt: COMPOSITE_IDENTITY.gh_run_attempt,
});
const statusRes = await fetch(`${TEST_SYSTEM_IO_URL}/api/v1/orchestration/status?${params.toString()}`, {
  headers: { Authorization: `Bearer ${TEST_SYSTEM_IO_BEARER}` },
});
let status = null;
try {
  status = await statusRes.json();
} catch {
  status = null;
}
if (status) console.log(JSON.stringify(status, null, 2));

// Dashboard URLs use only the trailing segment of the repository slug
// ("owner/repo" → "repo") to match the convention surfaced by the
// /reports/consolidated and /reports/grouped endpoints. Mirroring the same
// path shape used elsewhere in the UI keeps deep links consistent and
// browsable.
const repoSlug = COMPOSITE_IDENTITY.repository || '';
const repoTrailing = repoSlug.split('/').pop() || repoSlug;
const repo = encodeURIComponent(repoTrailing);
const branch = encodeURIComponent(COMPOSITE_IDENTITY.branch || 'main');
const shortSha = (COMPOSITE_IDENTITY.commit_sha || '').slice(0, 7);
const name = encodeURIComponent(COMPOSITE_IDENTITY.name);
const reportURL = `${TEST_SYSTEM_IO_URL}/reports/${repo}/${branch}/${shortSha}/${name}?gh_run_id=${encodeURIComponent(COMPOSITE_IDENTITY.gh_run_id)}`;

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const counts = (status && status.counts) || {};
  const total = (status && status.total_units) ?? '?';
  const lines = [
    '## E2E Test Results — Playwright (Test System IO orchestrated)',
    '',
    `**Run status:** \`${status?.status ?? 'unknown'}\``,
    '',
    '| metric | value |',
    '|---|---|',
    `| total units | ${total} |`,
    `| pass | ${counts.completed_pass ?? 0} |`,
    `| fail | ${counts.completed_fail ?? 0} |`,
    `| skipped | ${counts.completed_skipped ?? 0} |`,
    `| pending | ${counts.pending ?? 0} |`,
    `| leased | ${counts.leased ?? 0} |`,
    '',
    `[Open Report Group](${reportURL})`,
    '',
  ];
  fs.appendFileSync(summaryPath, lines.join('\n'));
}

const failOnTestFailures = process.env.FAIL_ON_TEST_FAILURES !== 'false';
if (status?.status !== 'completed') {
  console.error(`run did not complete cleanly: ${status?.status}`);
  if (failOnTestFailures) process.exit(1);
}
const failed = status?.counts?.completed_fail ?? 0;
if (failed > 0) {
  console.error(`${failed} unit(s) failed`);
  if (failOnTestFailures) process.exit(1);
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

#!/usr/bin/env node
// Discover Mattermost Playwright spec files under mm/e2e-tests/playwright/specs/,
// then call POST /api/v1/orchestration/begin and POST /api/v1/reports/begin so
// workers can drain the queue and the report-group exists for shard uploads.

import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ORCH_URL = required('ORCH_URL');
const TSIO_BEARER = required('TSIO_BEARER');
const MATTERMOST_DIR = required('MATTERMOST_DIR');
const IDENTITY = JSON.parse(required('IDENTITY'));
const RETEST_ON_FAIL = process.env.RETEST_ON_FAIL === 'true';
const RETEST_BUDGET = intEnv('RETEST_BUDGET', 1);
const LEASE_TIMEOUT_MS = intEnv('LEASE_TIMEOUT_MS', 600_000);
const RUN_TIMEOUT_MS = intEnv('RUN_TIMEOUT_MS', 7_200_000);
const PLAYWRIGHT_PROJECT = process.env.PLAYWRIGHT_PROJECT || 'chrome';

const PLAYWRIGHT_DIR = path.join(MATTERMOST_DIR, 'e2e-tests', 'playwright');

const specs = discoverSpecs();

if (specs.length === 0) {
  throw new Error(`no specs found under ${PLAYWRIGHT_DIR}`);
}

const dispatchUnits = specs.map((p) => ({ spec_path: p }));
console.log(`[controller] discovered ${dispatchUnits.length} spec file(s)`);

const beginBody = {
  ...IDENTITY,
  framework: 'playwright',
  playwright_project: PLAYWRIGHT_PROJECT,
  lease_timeout_ms: LEASE_TIMEOUT_MS,
  run_timeout_ms: RUN_TIMEOUT_MS,
  retest_on_fail: RETEST_ON_FAIL,
  retest_budget: RETEST_BUDGET,
  dispatch_units: dispatchUnits,
};

const beginRes = await fetch(`${ORCH_URL}/api/v1/orchestration/begin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TSIO_BEARER}` },
  body: JSON.stringify(beginBody),
});
if (beginRes.status !== 200 && beginRes.status !== 201) {
  const t = await beginRes.text();
  throw new Error(`orchestration/begin failed: ${beginRes.status} ${t}`);
}
console.log(`[controller] orchestration begun (${beginRes.status})`);

const reportsIdent = identityForReports();
const reportsRes = await fetch(`${ORCH_URL}/api/v1/reports/begin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TSIO_BEARER}` },
  body: JSON.stringify(reportsIdent),
});
if (reportsRes.status !== 200) {
  const t = await reportsRes.text();
  throw new Error(`reports/begin failed: ${reportsRes.status} ${t}`);
}
const { report_id } = await reportsRes.json();
console.log(`[controller] report group ready: ${report_id}`);

// Ask Playwright which spec files actually have runnable tests for the
// project (excluding @visual). Without this, begin would dispatch every
// *.spec.ts on disk and workers without matching tests would exit with
// "No tests found" — wasted runner time and noisy `completed_skipped`.
function discoverSpecs() {
  const args = ['playwright', 'test', '--list', '--reporter=json',
    `--project=${PLAYWRIGHT_PROJECT}`, '--grep-invert', '@visual'];
  const out = spawnSync('npx', args, {
    cwd: PLAYWRIGHT_DIR,
    encoding: 'utf8',
    env: { ...process.env, PW_SNAPSHOT_ENABLE: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.status !== 0) {
    throw new Error(`playwright --list failed (status=${out.status}): ${out.stderr || out.stdout}`);
  }
  let json;
  try {
    json = JSON.parse(out.stdout);
  } catch (e) {
    throw new Error(`failed to parse playwright --list JSON: ${e.message}\nstdout head: ${out.stdout.slice(0, 1000)}`);
  }
  const files = new Set();
  function visit(suite) {
    if (suite.file) files.add(suite.file);
    for (const sub of suite.suites || []) visit(sub);
  }
  for (const s of json.suites || []) visit(s);
  return [...files].filter((p) => !p.endsWith('test_setup.ts')).sort();
}

function identityForReports() {
  const body = {
    repository: IDENTITY.repository,
    commit: IDENTITY.commit_sha,
    gh_run_id: IDENTITY.gh_run_id,
    gh_run_attempt: IDENTITY.gh_run_attempt,
    framework: 'playwright',
    name: IDENTITY.name,
    branch: IDENTITY.branch,
  };
  if (IDENTITY.gh_pr_number != null) body.gh_pr_number = IDENTITY.gh_pr_number;
  return body;
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function intEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name}=${v} is not an integer`);
  return n;
}

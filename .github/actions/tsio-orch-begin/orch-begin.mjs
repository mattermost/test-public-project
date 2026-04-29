#!/usr/bin/env node
// Discover Mattermost Playwright spec files under mm/e2e-tests/playwright/specs/,
// then call POST /api/v1/orchestration/begin and POST /api/v1/reports/begin so
// workers can drain the queue and the report-group exists for shard uploads.

import fs from 'node:fs';
import path from 'node:path';

const TEST_SYSTEM_IO_URL = required('TEST_SYSTEM_IO_URL');
const TEST_SYSTEM_IO_BEARER = required('TEST_SYSTEM_IO_BEARER');
const MATTERMOST_DIR = required('MATTERMOST_DIR');
const COMPOSITE_IDENTITY = JSON.parse(required('COMPOSITE_IDENTITY'));
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
  ...COMPOSITE_IDENTITY,
  framework: 'playwright',
  playwright_project: PLAYWRIGHT_PROJECT,
  lease_timeout_ms: LEASE_TIMEOUT_MS,
  run_timeout_ms: RUN_TIMEOUT_MS,
  retest_on_fail: RETEST_ON_FAIL,
  retest_budget: RETEST_BUDGET,
  dispatch_units: dispatchUnits,
};

const beginRes = await fetch(`${TEST_SYSTEM_IO_URL}/api/v1/orchestration/begin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_SYSTEM_IO_BEARER}` },
  body: JSON.stringify(beginBody),
});
if (beginRes.status !== 200 && beginRes.status !== 201) {
  const t = await beginRes.text();
  throw new Error(`orchestration/begin failed: ${beginRes.status} ${t}`);
}
console.log(`[controller] orchestration begun (${beginRes.status})`);

const reportsIdent = identityForReports();
const reportsRes = await fetch(`${TEST_SYSTEM_IO_URL}/api/v1/reports/begin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_SYSTEM_IO_BEARER}` },
  body: JSON.stringify(reportsIdent),
});
if (reportsRes.status !== 200) {
  const t = await reportsRes.text();
  throw new Error(`reports/begin failed: ${reportsRes.status} ${t}`);
}
const { report_id } = await reportsRes.json();
console.log(`[controller] report group ready: ${report_id}`);

// Walk e2e-tests/playwright/specs/ for *.spec.ts. Excludes:
//   - specs/visual/**          — covered by the worker's `--grep-invert @visual`
//   - specs/test_setup.ts      — runs as a Playwright project dependency, not
//                                 as a dispatched unit
// Discovery deliberately skips `playwright test --list` so the controller
// doesn't need to install + build playwright-lib (which would require the
// whole webapp workspace to compile).
function discoverSpecs() {
  const SPECS_DIR = path.join(PLAYWRIGHT_DIR, 'specs');
  const out = [];
  function rec(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) rec(full);
      else if (ent.isFile() && /\.spec\.ts$/.test(ent.name)) out.push(full);
    }
  }
  rec(SPECS_DIR);
  return out
    .map((abs) => path.relative(PLAYWRIGHT_DIR, abs).split(path.sep).join('/'))
    .filter((p) => !p.endsWith('test_setup.ts'))
    .filter((p) => !p.startsWith('specs/visual/'))
    .sort();
}

function identityForReports() {
  const body = {
    repository: COMPOSITE_IDENTITY.repository,
    commit: COMPOSITE_IDENTITY.commit_sha,
    gh_run_id: COMPOSITE_IDENTITY.gh_run_id,
    gh_run_attempt: COMPOSITE_IDENTITY.gh_run_attempt,
    framework: 'playwright',
    name: COMPOSITE_IDENTITY.name,
    branch: COMPOSITE_IDENTITY.branch,
  };
  if (COMPOSITE_IDENTITY.gh_pr_number != null) body.gh_pr_number = COMPOSITE_IDENTITY.gh_pr_number;
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

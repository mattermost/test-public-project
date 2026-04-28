#!/usr/bin/env node
// Drain the orchestration queue, run mattermost's `make run-specs SPEC_FILES=...`
// per leased spec, archive the per-iteration Playwright JSON + screenshots, and
// at queue-empty upload the worker's accumulated artifacts as ONE shard report.
//
// Identity comes from $IDENTITY (composite) + $GH_JOB_ID/$GH_JOB_NAME (worker).
// The orchestrator looks up the worker's lease by (run, gh_job_id) so workers
// never see a lease_id.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ORCH_URL = required('ORCH_URL');
const TSIO_BEARER = required('TSIO_BEARER');
const IDENTITY = JSON.parse(required('IDENTITY'));
const GH_JOB_ID = required('GH_JOB_ID');
const GH_JOB_NAME = process.env.GH_JOB_NAME || 'orch-worker';
const MATTERMOST_DIR = required('MATTERMOST_DIR');
const ARTIFACTS_ROOT = required('ARTIFACTS_ROOT');

const E2E_DIR = path.join(MATTERMOST_DIR, 'e2e-tests');
const PLAYWRIGHT_DIR = path.join(E2E_DIR, 'playwright');
const RESULTS_DIR = path.join(PLAYWRIGHT_DIR, 'results');

const WORKER_ARTIFACTS = path.join(ARTIFACTS_ROOT, GH_JOB_ID);
fs.mkdirSync(WORKER_ARTIFACTS, { recursive: true });

let iterationSeq = 0;
const invocations = []; // { specPath, iterDir, playwrightJsonPath }

await main();

async function main() {
  let leasesHeld = 0;
  while (true) {
    const checkout = await postJSON('/api/v1/orchestration/checkout', {
      ...IDENTITY,
      gh_job_name: GH_JOB_NAME,
      gh_job_id: GH_JOB_ID,
      batch_size: 1,
    });

    if (checkout.status === 409 && checkout.body?.code === 'WORKER_HAS_ACTIVE_LEASE') {
      console.log('[worker] active lease still recorded; waiting');
      await sleep(2000);
      continue;
    }
    if (checkout.status === 409 && checkout.body?.code === 'RUN_NOT_IN_PROGRESS') {
      console.log('[worker] run no longer in_progress; exiting');
      break;
    }
    if (checkout.status !== 200) {
      throw new Error(`checkout failed: ${checkout.status} ${JSON.stringify(checkout.body)}`);
    }

    if (checkout.body.queue_empty) {
      console.log(`[worker] queue empty after ${leasesHeld} unit(s); exiting cleanly`);
      break;
    }

    leasesHeld += 1;
    const isRetest = !!checkout.body.is_retest;
    const specPaths = checkout.body.units.map((u) => u.spec_path);
    console.log(`[worker] leased (${isRetest ? 'retest' : 'fresh'}): ${specPaths.join(', ')}`);

    let results;
    try {
      results = await runUnit(specPaths);
    } catch (err) {
      console.error(`[worker] dispatch error: ${err.message}`);
      results = specPaths.map((spec_path) => ({
        spec_path,
        status: 'failed',
        actual_duration_ms: 0,
        error_message: `worker dispatch failure: ${err.message}`,
      }));
    }

    const completeRes = await postJSON('/api/v1/orchestration/complete', {
      ...IDENTITY,
      gh_job_name: GH_JOB_NAME,
      gh_job_id: GH_JOB_ID,
      results,
    });
    if (completeRes.status !== 200) {
      throw new Error(`complete failed: ${completeRes.status} ${JSON.stringify(completeRes.body)}`);
    }
    const transitions = (completeRes.body?.unit_states_changed || [])
      .map((c) => c.new_state)
      .join(',');
    console.log(`[worker] reported (${results.map((r) => r.status).join(',')}) → ${transitions || '(no transition)'}`);
  }

  await uploadShard();
}

async function runUnit(specPaths) {
  const iterDir = path.join(WORKER_ARTIFACTS, `iter-${iterationSeq++}`);
  fs.mkdirSync(iterDir, { recursive: true });

  // mattermost's run-specs takes a comma-separated list and runs Playwright
  // inside the `playwright` docker container. Spec paths are relative to
  // e2e-tests/playwright (e.g. "specs/channels/foo.spec.ts").
  const specArg = specPaths.join(',');
  const startedAt = Date.now();
  const child = spawnSync('make', ['run-specs'], {
    cwd: E2E_DIR,
    env: { ...process.env, SPEC_FILES: specArg },
    stdio: 'inherit',
  });
  const durationMs = Date.now() - startedAt;
  console.log(`[worker] make run-specs exit ${child.status} in ${Math.round(durationMs / 1000)}s`);

  // Copy the raw results dir before the next iteration overwrites it.
  if (!fs.existsSync(RESULTS_DIR)) {
    throw new Error(`results dir missing after run-specs: ${RESULTS_DIR}`);
  }
  const archivedResults = path.join(iterDir, 'results');
  fs.cpSync(RESULTS_DIR, archivedResults, { recursive: true });

  const playwrightJsonPath = path.join(archivedResults, 'reporter', 'results.json');
  if (!fs.existsSync(playwrightJsonPath)) {
    throw new Error(`playwright results.json missing: ${playwrightJsonPath}`);
  }

  invocations.push({
    specPath: specPaths[0],
    iterDir: archivedResults,
    playwrightJsonPath,
  });

  const json = JSON.parse(fs.readFileSync(playwrightJsonPath, 'utf8'));
  return specPaths.map((p) => aggregateSpec(json, p, durationMs));
}

// aggregateSpec walks the Playwright JSON reporter output and produces a
// TSIO SpecResult for `specPath`. Status is the worst of any test attempt in
// the spec's suite tree. test_cases mirrors columns on the TSIO test_cases
// table, one row per test attempt (so retries surface as separate rows).
function aggregateSpec(json, specPath, fallbackDurationMs) {
  const fileSuite = (json.suites || []).find(
    (s) => s.file === specPath || s.title === specPath,
  );
  if (!fileSuite) {
    return { spec_path: specPath, status: 'skipped', actual_duration_ms: 0, test_cases: [] };
  }

  const ranks = { passed: 0, skipped: 1, flaky: 2, interrupted: 3, timedOut: 4, failed: 5 };
  const cases = [];
  let totalMs = 0;
  let worst = 'skipped';

  function visit(suite, ancestors) {
    const here = suite.title ? [...ancestors, suite.title] : ancestors;
    for (const s of suite.specs || []) {
      const specTitle = [...here, s.title];
      for (const t of s.tests || []) {
        for (const r of t.results || []) {
          const status = mapStatus(r.status);
          const tc = {
            title: s.title,
            full_title: specTitle.join(' > '),
            status,
            retry_count: r.retry || 0,
            duration_ms: r.duration || 0,
            ordinal: cases.length,
          };
          const err = (r.errors && r.errors[0]) || r.error;
          if (err?.message) tc.error_message = err.message;
          if (err?.stack) tc.error_stack = err.stack;
          cases.push(tc);
          totalMs += tc.duration_ms;
          if ((ranks[status] ?? 0) > (ranks[worst] ?? 0)) worst = status;
        }
      }
    }
    for (const sub of suite.suites || []) visit(sub, here);
  }
  visit(fileSuite, []);

  const out = {
    spec_path: specPath,
    status: worst,
    actual_duration_ms: totalMs || fallbackDurationMs,
    test_cases: cases,
  };
  const firstFail = cases.find((c) => c.status === 'failed' || c.status === 'timedOut' || c.status === 'interrupted');
  if (firstFail?.error_message) out.error_message = firstFail.error_message;
  if (firstFail?.error_stack) out.error_stack = firstFail.error_stack;
  return out;
}

function mapStatus(s) {
  switch (s) {
    case 'expected':
    case 'passed':
      return 'passed';
    case 'unexpected':
    case 'failed':
      return 'failed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    case 'timedOut':
      return 'timedOut';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}

async function uploadShard() {
  if (invocations.length === 0) {
    console.log('[worker] no invocations; nothing to upload');
    return;
  }

  const reportsIdent = identityForReports();

  // Idempotent — controller already called this; calling again is a no-op.
  const beginRes = await postJSON('/api/v1/reports/begin', reportsIdent);
  if (beginRes.status !== 200 && beginRes.status !== 201) {
    throw new Error(`reports/begin failed: ${beginRes.status} ${JSON.stringify(beginRes.body)}`);
  }
  const reportGroupID = beginRes.body.report_id;

  const jsonParts = [];
  const screenshotParts = [];
  for (let i = 0; i < invocations.length; i++) {
    const inv = invocations[i];
    if (fs.existsSync(inv.playwrightJsonPath)) {
      const stat = fs.statSync(inv.playwrightJsonPath);
      const rel =
        invocations.length > 1 ? `playwright-results-${i}.json` : 'playwright-results.json';
      jsonParts.push({ absPath: inv.playwrightJsonPath, relPath: rel, size: stat.size });
    }
    const outputRoot = path.join(inv.iterDir, 'output');
    if (fs.existsSync(outputRoot)) {
      for (const img of listImages(outputRoot)) {
        // Prefix with iter index so multi-spec workers cannot collide on relative path.
        const prefixed = invocations.length > 1 ? `iter-${i}/${img.relPath}` : img.relPath;
        screenshotParts.push({ ...img, relPath: prefixed });
      }
    }
  }

  if (jsonParts.length === 0) {
    console.log('[worker] no playwright json to upload');
    return;
  }

  const regBody = {
    ...reportsIdent,
    gh_job_id: GH_JOB_ID,
    gh_job_name: GH_JOB_NAME,
    json_files: jsonParts.map((p) => ({ path: p.relPath, size: p.size })),
    screenshots: screenshotParts.map((s) => ({ path: s.relPath, size: s.size })),
  };
  const regRes = await postJSON('/api/v1/reports/register', regBody);
  if (regRes.status !== 200) {
    throw new Error(`reports/register failed: ${regRes.status} ${JSON.stringify(regRes.body)}`);
  }
  const uploadID = regRes.body.upload_id;

  await uploadMultipart(`/api/v1/reports/upload/${reportGroupID}/${uploadID}/json`, jsonParts, 'application/json');
  if (screenshotParts.length > 0) {
    await uploadMultipart(`/api/v1/reports/upload/${reportGroupID}/${uploadID}/screenshots`, screenshotParts);
  }

  console.log(
    `[worker] shard uploaded: ${jsonParts.length} json + ${screenshotParts.length} screenshot(s) (group=${reportGroupID}, upload=${uploadID})`,
  );
}

async function uploadMultipart(urlPath, parts, defaultType) {
  const form = new FormData();
  for (const p of parts) {
    const buf = fs.readFileSync(p.absPath);
    const type = p.contentType || defaultType || 'application/octet-stream';
    form.append('files', new Blob([buf], { type }), p.relPath);
  }
  const res = await fetch(`${ORCH_URL}${urlPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TSIO_BEARER}` },
    body: form,
  });
  if (res.status !== 200) {
    const t = await res.text().catch(() => '');
    throw new Error(`POST ${urlPath} failed: ${res.status} ${t}`);
  }
}

function listImages(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const dir = ent.parentPath || ent.path || root;
    const abs = path.join(dir, ent.name);
    const ext = path.extname(abs).toLowerCase();
    const ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      null;
    if (!ct) continue;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    out.push({
      absPath: abs,
      relPath: path.relative(root, abs).split(path.sep).join('/'),
      size: stat.size,
      contentType: ct,
    });
  }
  return out;
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

async function postJSON(urlPath, body) {
  const res = await fetch(`${ORCH_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TSIO_BEARER}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text.length) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

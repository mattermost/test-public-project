#!/usr/bin/env node
// Opens a logs response, as the destroy workflow uploads it (e2e-test-stack-logs-<index>), with the repository's
// private key, and writes the server's decoded log tail to stdout.
//
//   E2E_STACK_PRIVATE_KEY=<base64 key> node scripts/open-logs.mjs e2e-test-stack-logs.json > server.log
//
// The tail may hold secrets: keep it local. The full log's URL is printed to stderr; it expires 30 minutes after the
// logs call.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import sodium from 'libsodium-wrappers';

const [path] = process.argv.slice(2);
const key = process.env.E2E_STACK_PRIVATE_KEY ?? '';
if (!path || !key) {
  console.error('usage: E2E_STACK_PRIVATE_KEY=<base64 key> node scripts/open-logs.mjs <logs response.json>');
  process.exit(2);
}

let response;
try {
  response = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`${path} could not be read as JSON: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const logs = response.logs;
if (!logs?.secrets) {
  console.error(`${path} holds no sealed logs${logs?.no_object ? ': the server wrote no log object' : ''}`);
  process.exit(1);
}

await sodium.ready;
let privateKey;
try {
  privateKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
} catch {
  console.error('E2E_STACK_PRIVATE_KEY is not standard base64');
  process.exit(2);
}
let plain;
try {
  const box = sodium.from_base64(logs.secrets, sodium.base64_variants.ORIGINAL);
  plain = sodium.to_string(sodium.crypto_box_seal_open(box, sodium.crypto_scalarmult_base(privateKey), privateKey));
} catch {
  console.error(`${path}'s logs did not open with E2E_STACK_PRIVATE_KEY; is it this repository's key?`);
  process.exit(1);
}
let opened;
try {
  opened = JSON.parse(plain);
} catch {
  console.error(`${path}'s logs opened but do not hold JSON`);
  process.exit(1);
}

console.error(
  `batch ${response.batch_id}, server ${logs.index ?? 0} (${logs.instance_id}): ${logs.lines ?? 0} lines, ` +
    `${logs.bytes ?? 0} bytes${logs.truncated ? ', truncated' : ''}; containers: ${(logs.containers ?? []).join(', ')}`,
);
if (opened.url) console.error(`full log (expires 30 minutes after the logs call): ${opened.url}`);
if (opened.content_gzip) process.stdout.write(gunzipSync(Buffer.from(opened.content_gzip, 'base64')));

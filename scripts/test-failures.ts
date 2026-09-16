/**
 * Proves: Apollo rate limits and failures are absorbed without losing the run.
 *
 * Points the client at a local stub via APOLLO_BASE_URL and drives real 429/500/422
 * responses through the worker's error path.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

/**
 * Spawn the worker as a direct child of this process.
 *
 * Going through `npx tsx` starts npx, which starts node as a *grandchild*: SIGKILL then
 * kills the wrapper while the real worker keeps running, orphaning it. These suites kill
 * workers constantly, so orphans accumulate and quietly corrupt later assertions.
 * `node --import tsx` is one process, and signals reach it.
 */
const NODE = process.execPath;
const TSX = ['--import', 'tsx'] as const;
import { readFileSync } from 'node:fs';
import { pool, q } from '../src/db.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mode = '429';
let calls = 0;

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls++;
    const json = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if ((req.url ?? '').startsWith('/mixed_people/api_search'))
      return json(200, { people: [{ id: 'stub-1', first_name: 'Stub',
                                    organization: { name: 'Stub Co' } }] });
    if (mode === '429') return json(429, { error: 'rate limited' }, { 'retry-after': '2' });
    if (mode === '500') return json(500, { error: 'boom' });
    if (mode === '422') return json(422, { error: 'permanently bad record' });
    return json(200, { person: { id: 'stub-1', name: 'Stub Person', title: 'CTO',
                                 headline: 'recovered after retries' } });
  });
});
await new Promise<void>((r) => { stub.listen(0, () => r()); });
const addr = stub.address();
if (!addr || typeof addr === 'string') throw new Error('stub did not bind a port');
const base = `http://127.0.0.1:${addr.port}`;


/** Wait for the process to actually be gone; a fixed sleep lets it survive into the next
 *  suite's fresh room and quietly corrupt that suite's counts. */
const stop = (p: import('node:child_process').ChildProcess, signal: NodeJS.Signals = 'SIGKILL') =>
  new Promise<void>((r) => { p.once('exit', () => r()); p.kill(signal); });

const worker = () => spawn(NODE, [...TSX, 'src/worker.ts'],
  { stdio: 'ignore', env: { ...process.env, APOLLO_BASE_URL: base } });

const task = async () => (await q(
  `select * from tasks where room_id = $1`, [room.id])).rows[0];

async function waitFor(fn, label, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(300); }
  throw new Error(`timed out waiting for ${label}`);
}

// Start from a clean schema: rooms left behind by an earlier suite keep the worker busy
// and make the attempt counts below meaningless.
await q(readFileSync('schema.sql', 'utf8'));
const { rows: [room] } = await q(
  `insert into rooms (objective, icp) values ('Failure test','CTO') returning *`);
await q(`insert into room_members (room_id, name, kind) values ($1,'alice','human'), ($1,'agent','agent')`,
  [room.id]);

// 1. a 429 schedules a durable backoff instead of dropping the task
let w = worker();
const rated = await waitFor(async () => {
  const t = await task();
  return t?.attempts > 0 ? t : null;
}, 'a rate-limited attempt');
await stop(w);

assert.equal(rated.state, 'pending_enrich', '429 must not advance or fail the task');
assert.ok(rated.last_error.includes('rate limited'), `unexpected error: ${rated.last_error}`);
assert.ok(new Date(rated.next_run_at) > new Date(),
  'Retry-After should have pushed next_run_at into the future');
const waitSecs = (new Date(rated.next_run_at).getTime() - Date.now()) / 1000;
assert.ok(waitSecs <= 2.5, `should honour Retry-After: 2, waited ${waitSecs}s`);
console.log(`PASS  429: task held at ${rated.state}, retry in ${waitSecs.toFixed(1)}s (Retry-After honoured)`);

// 2. the task survives a restart and completes once the upstream recovers
mode = '200';
await q(`update tasks set next_run_at = now() where room_id = $1`, [room.id]);
w = worker();
const ok = await waitFor(async () => {
  const t = await task();
  return t?.state === 'awaiting_review' ? t : null;
}, 'recovery after the rate limit');
await stop(w);
assert.equal(ok.enrichment.headline, 'recovered after retries');
assert.equal(ok.attempts, 0, 'attempts should reset on success');
console.log('PASS  recovery: the same task completed after the limit cleared — run never lost');

// 3. a non-retryable 4xx fails that task fast, without burning 5 attempts
mode = '422';
await q(`delete from task_steps`);
await q(`update tasks set state='pending_enrich', attempts=0, enrichment=null,
         next_run_at=now() where room_id=$1`, [room.id]);
w = worker();
const dead = await waitFor(async () => {
  const t = await task();
  return t?.state === 'failed' ? t : null;
}, 'a permanent failure');
await stop(w);
assert.equal(dead.attempts, 1, 'a 422 should not be retried');
console.log(`PASS  422: failed after 1 attempt, not 5 ("${dead.last_error.slice(0, 40)}…")`);

await q('delete from rooms where id = $1', [room.id]);
await pool.end();
stub.close();
console.log(`\nall failure checks passed (${calls} stubbed Apollo calls)`);

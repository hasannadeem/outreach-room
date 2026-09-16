/**
 * Proves: kill -9 mid-run, restart, it picks up where it was and nothing is redone.
 *
 * The proof is task_steps.created_at. Inserts are ON CONFLICT DO NOTHING, so a step that
 * re-executed after the restart would carry a new timestamp. Identical timestamps across
 * the crash mean those Apollo calls never happened a second time.
 */
import assert from 'node:assert/strict';
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
const snapshot = async () => (await q(
  `select task_id, step, created_at from task_steps order by task_id, step`)).rows;


/** Wait for the process to actually be gone; a fixed sleep lets it survive into the next
 *  suite's fresh room and quietly corrupt that suite's counts. */
const stop = (p: import('node:child_process').ChildProcess, signal: NodeJS.Signals = 'SIGKILL') =>
  new Promise<void>((r) => { p.once('exit', () => r()); p.kill(signal); });

const runWorker = () => spawn(NODE, [...TSX, 'src/worker.ts'], { stdio: 'inherit', env: process.env });

async function waitFor(fn, label, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

console.log('--- reset ---');
await q(readFileSync('schema.sql', 'utf8'));
const { rows: [room] } = await q(
  `insert into rooms (objective, icp) values ($1,$2) returning *`,
  ['Crash test', 'VP of Engineering or CTO in the United States']);

console.log('--- start worker, kill -9 mid-run ---');
let w = runWorker();
await waitFor(async () =>
  Number((await q('select count(*) from task_steps')).rows[0].count) >= 3, 'first steps');
await stop(w);

const before = await snapshot();
const tasksBefore = Number((await q('select count(*) from tasks')).rows[0].count);
console.log(`killed with ${before.length} step(s) committed across ${tasksBefore} task(s)`);
assert.ok(before.length >= 3, 'expected some committed work before the kill');
assert.ok(tasksBefore > 0, 'search should have committed its tasks');

console.log('--- restart, run to completion ---');
w = runWorker();
await waitFor(async () => Number((await q(
  `select count(*) from tasks where state not in ('awaiting_review','done','failed')`
)).rows[0].count) === 0, 'all tasks reviewed');
await stop(w, 'SIGTERM');

const after = await snapshot();
const key = (r) => `${r.task_id}:${r.step}`;
const afterByKey = new Map(after.map((r) => [key(r), r]));

// 1. nothing that had already committed ran again
for (const row of before) {
  const now = afterByKey.get(key(row));
  assert.ok(now, `step ${key(row)} vanished after restart`);
  assert.equal(now.created_at.getTime(), row.created_at.getTime(),
    `step ${key(row)} was re-executed after the crash`);
}
// 2. the run actually resumed rather than stalling
assert.ok(after.length > before.length, 'no progress was made after the restart');
// 3. no task was enriched or drafted twice
const dupes = (await q(
  `select task_id, step, count(*) from task_steps group by 1,2 having count(*) > 1`)).rows;
assert.equal(dupes.length, 0, `duplicate steps: ${JSON.stringify(dupes)}`);
// 4. every task reached review with exactly one enrich and one draft
const { rows: [tally] } = await q(`
  select count(*) filter (where state = 'awaiting_review') as reviewed,
         count(*) as total,
         (select count(*) from task_steps s where s.step = 'enrich') as enrich,
         (select count(*) from task_steps s where s.step = 'draft')  as draft
  from tasks where room_id = $1`, [room.id]);
assert.equal(tally.reviewed, tally.total, 'some tasks did not reach review');
assert.equal(tally.enrich, tally.total, 'enrich count != task count');
assert.equal(tally.draft, tally.total, 'draft count != task count');

console.log(`\nPASS  ${before.length} step(s) survived the kill unchanged, ` +
            `${after.length - before.length} more ran after restart, 0 duplicates, ` +
            `${tally.total}/${tally.total} tasks awaiting review`);
await pool.end();

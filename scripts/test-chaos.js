/**
 * The brief's guarantees, attacked rather than asserted.
 *
 * test-crash.js kills the worker once. This kills it repeatedly at random moments, runs
 * four workers at once, races a human against the agent mid-step, and expires a claim
 * under the agent's feet.
 *
 * The invariant every section checks is the same, and it is stronger than "no duplicate
 * rows": task_steps has a primary key, so duplicates are impossible by construction and
 * proving their absence proves nothing. Instead we count *committed events* — the agent
 * logs 'enriched'/'drafted' in the same transaction as the step. Two workers that both
 * processed one task would commit two events. Exactly one per task per step means the work
 * happened exactly once.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pool, q } from '../src/db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
const count = async (sql, p) => Number((await q(sql, p)).rows[0].count);

// Always replay fixtures here, even when a live key is set: this suite restarts the worker
// a dozen times and would otherwise burn real Apollo credits to test concurrency semantics
// that have nothing to do with Apollo.
const worker = (env = {}) =>
  spawn('node', ['src/worker.js'],
    { stdio: 'ignore', env: { ...process.env, APOLLO_FIXTURES: '1', ...env } });

/**
 * Wait for the process to actually be gone. Sleeping instead deadlocks the next section:
 * its schema reset wants AccessExclusiveLock while this worker still holds row locks.
 */
const stop = (w, signal = 'SIGKILL') =>
  new Promise((r) => { w.once('exit', r); w.kill(signal); });

async function waitFor(fn, label, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error(`timed out waiting for ${label}`);
}

async function freshRoom(objective) {
  await q(readFileSync('schema.sql', 'utf8'));
  const { rows: [room] } = await q(
    `insert into rooms (objective, icp) values ($1, 'CTO in the United States') returning *`,
    [objective]);
  await q(`insert into room_members (room_id, name, kind) values
           ($1,'alice','human'), ($1,'bob','human'), ($1,'ghost','human'),
           ($1,'agent','agent')`, [room.id]);
  return room;
}

const allReviewed = async () =>
  (await count(`select count(*) from tasks where state not in ('awaiting_review','done','failed')`)) === 0
  && (await count('select count(*) from tasks')) > 0;

/** The invariant: every task was enriched exactly once and drafted exactly once. */
async function assertExactlyOnce(context) {
  const tasks = await count('select count(*) from tasks');
  const { rows } = await q(`
    select type, count(*)::int as n, count(distinct task_id)::int as tasks
    from events where type in ('enriched','drafted') group by type`);
  const by = Object.fromEntries(rows.map((r) => [r.type, r]));

  for (const type of ['enriched', 'drafted']) {
    assert.ok(by[type], `${context}: no '${type}' events at all`);
    assert.equal(by[type].tasks, tasks, `${context}: '${type}' covered ${by[type].tasks}/${tasks} tasks`);
    assert.equal(by[type].n, tasks,
      `${context}: ${by[type].n} '${type}' events for ${tasks} tasks — work happened more than once`);
  }
  const dupes = (await q(
    `select task_id, step from task_steps group by 1,2 having count(*) > 1`)).rows;
  assert.equal(dupes.length, 0, `${context}: duplicate ledger rows`);
  return tasks;
}

// ─── 1. survive being killed over and over, at random moments ───────────────────
{
  await freshRoom('Chaos: repeated kills');
  let w = worker();
  let kills = 0;

  // Kill until the room is finished, or we've hit it plenty of times.
  while (kills < 8 && !(await allReviewed())) {
    await sleep(rand(250, 700));
    w.kill('SIGKILL');
    kills++;
    w = worker();
  }
  await waitFor(allReviewed, 'the room to finish despite the kills');
  await stop(w);

  const tasks = await assertExactlyOnce('repeated kills');
  console.log(`PASS  survived ${kills} × kill -9 at random moments — ` +
              `${tasks}/${tasks} tasks enriched once and drafted once`);
}

// ─── 2. four workers at once must not double-process anything ───────────────────
{
  await freshRoom('Chaos: concurrent workers');
  const ws = Array.from({ length: 4 }, () => worker());
  await waitFor(allReviewed, 'four workers to finish the room');
  await Promise.all(ws.map((w) => stop(w)));

  const tasks = await assertExactlyOnce('4 concurrent workers');
  console.log(`PASS  4 workers racing on one room — ${tasks}/${tasks} tasks processed ` +
              `exactly once (FOR UPDATE SKIP LOCKED)`);
}

// ─── 3. a human claiming a task the agent is mid-step on ────────────────────────
{
  await freshRoom('Chaos: human vs agent');
  // Slow the replayed Apollo call right down so there is a wide window to race into.
  const w = worker({ FIXTURE_LATENCY_MS: '2500' });

  const task = await waitFor(async () =>
    (await q(`select * from tasks where state = 'pending_enrich' limit 1`)).rows[0],
    'the agent to create tasks');

  await sleep(600);   // the agent is now inside enrichPerson, holding this row's lock

  const claimed = await q(
    `update tasks set claimed_by = 'alice', claim_expires_at = now() + interval '5 minutes',
                      version = version + 1
     where id = $1 and version = $2 returning *`, [task.id, task.version]);

  // SIGTERM, not SIGKILL: the point is to let the in-flight step commit, then compare.
  await stop(w, 'SIGTERM');

  const { rows: [after] } = await q('select * from tasks where id = $1', [task.id]);
  // Either order is correct; what must never happen is a torn row — claimed but with the
  // agent's write lost, or enriched with the human's claim silently dropped.
  assert.equal(claimed.rows.length, 1, 'the human claim should eventually land, not error');
  assert.equal(after.claimed_by, 'alice', 'the claim was lost');
  assert.ok(['pending_enrich', 'enriched'].includes(after.state), `torn state: ${after.state}`);
  if (after.state === 'enriched')
    assert.ok(after.enrichment?.name, 'enriched state without enrichment data — torn write');

  const n = await count(
    `select count(*) from events where task_id = $1 and type = 'enriched'`, [task.id]);
  assert.ok(n <= 1, `agent committed ${n} enrich events for one task`);
  console.log(`PASS  human claimed a task mid-step — claim held, state coherent ` +
              `(${after.state}), no torn write`);
}

// ─── 4. an abandoned claim is reaped, not held forever ──────────────────────────
{
  await freshRoom('Chaos: claim lease');
  let w = worker();
  const task = await waitFor(async () =>
    (await q(`select * from tasks where state = 'pending_enrich' limit 1`)).rows[0],
    'the agent to create tasks');
  await stop(w);

  // A human claims it, then walks away: lease already expired.
  await q(`update tasks set claimed_by = 'ghost', claim_expires_at = now() - interval '1 minute'
           where id = $1`, [task.id]);
  // And one held by a live human, which must stay untouched.
  const { rows: [held] } = await q(
    `update tasks set claimed_by = 'alice', claim_expires_at = now() + interval '5 minutes'
     where id <> $1 and state = 'pending_enrich' returning *`, [task.id]);

  w = worker();
  await waitFor(async () =>
    (await q(`select 1 from tasks where id = $1 and state <> 'pending_enrich'`, [task.id])).rows[0],
    'the agent to reclaim the expired lease');
  await stop(w);

  const { rows: [still] } = await q('select * from tasks where id = $1', [held.id]);
  assert.equal(still.state, 'pending_enrich', "the agent took a task a human actively holds");
  console.log('PASS  expired claim reaped by the agent; a live claim left alone');
}

await pool.end();
console.log('\nall chaos checks passed');

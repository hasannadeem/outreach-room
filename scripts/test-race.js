/**
 * Proves: two humans acting on the same task at once can't both win.
 *
 * Uses synthetic tasks inserted straight into 'awaiting_review' — the concurrency rules
 * live entirely in the conditional UPDATE, so this needs no Apollo calls to exercise.
 * Requires the API to be running (npm start).
 */
import assert from 'node:assert/strict';
import { pool, q } from '../src/db.js';

const BASE = `http://localhost:${process.env.PORT || 3000}`;

const act = (taskId, action, actor, version, note) =>
  fetch(`${BASE}/api/tasks/${taskId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor, version, note }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const { rows: [room] } = await q(
  `insert into rooms (objective, icp) values ('Race test','n/a') returning *`);
// A room is its roster: alice and bob are members, carol is not, and the agent is a member
// too so ownership can be attributed to it.
await q(`insert into room_members (room_id, name, kind) values
         ($1,'alice','human'), ($1,'bob','human'), ($1,'agent','agent')`, [room.id]);

const freshTask = async () => (await q(
  `insert into tasks (room_id, person_key, person, state, draft)
   values ($1, $2, '{"first_name":"Test"}', 'awaiting_review', 'a draft')
   returning *`, [room.id, `race-${crypto.randomUUID()}`])).rows[0];

try {
  await fetch(`${BASE}/api/rooms`).then((r) => r.ok || Promise.reject());
} catch {
  console.error(`API not reachable at ${BASE} — run: npm start`);
  process.exit(1);
}

// 1. both humans approve the same version at the same instant
{
  const t = await freshTask();
  const [a, b] = await Promise.all([
    act(t.id, 'approve', 'alice', t.version),
    act(t.id, 'approve', 'bob', t.version),
  ]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409], `expected one winner, got ${codes}`);
  const { rows: [after] } = await q('select * from tasks where id = $1', [t.id]);
  assert.equal(after.state, 'done');
  assert.equal(after.version, t.version + 1, 'exactly one write should have landed');
  console.log(`PASS  concurrent approve: one 200, one 409 ("${(a.body.error || b.body.error)}")`);
}

// 2. both humans claim at the same instant
{
  const t = await freshTask();
  const [a, b] = await Promise.all([
    act(t.id, 'claim', 'alice', t.version),
    act(t.id, 'claim', 'bob', t.version),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'expected exactly one claimer');
  const { rows: [after] } = await q('select * from tasks where id = $1', [t.id]);
  assert.ok(['alice', 'bob'].includes(after.claimed_by));
  console.log(`PASS  concurrent claim: ${after.claimed_by} holds it, the other got 409`);
}

// 3. a claim locks the other human out of deciding
{
  const t = await freshTask();
  const claim = await act(t.id, 'claim', 'alice', t.version);
  assert.equal(claim.status, 200);
  const bob = await act(t.id, 'approve', 'bob', claim.body.version);
  assert.equal(bob.status, 409, 'bob should not be able to approve alice\'s claimed task');
  const alice = await act(t.id, 'approve', 'alice', claim.body.version);
  assert.equal(alice.status, 200, 'the claimer should still be able to approve');
  console.log(`PASS  claimed task: bob 409 ("${bob.body.error}"), alice 200`);
}

// 4. acting on a version you no longer have is rejected
{
  const t = await freshTask();
  assert.equal((await act(t.id, 'claim', 'alice', t.version)).status, 200);
  const stale = await act(t.id, 'approve', 'alice', t.version);   // pre-claim version
  assert.equal(stale.status, 409, 'stale version should be rejected');
  console.log(`PASS  stale version rejected ("${stale.body.error}")`);
}

// 5. handback at review time re-arms the draft step for the agent
{
  const t = await freshTask();
  await q(`insert into task_steps (task_id, step, output) values ($1,'draft','"old"')`, [t.id]);
  const r = await act(t.id, 'handback', 'alice', t.version);
  assert.equal(r.status, 200);
  const { rows: [after] } = await q('select * from tasks where id = $1', [t.id]);
  const { rows: steps } = await q(
    `select * from task_steps where task_id = $1 and step = 'draft'`, [t.id]);
  assert.equal(after.state, 'enriched', 'handback should send it back to the agent');
  assert.equal(after.draft, null);
  assert.equal(steps.length, 0, 'the draft ledger entry should be cleared so it redrafts');
  console.log('PASS  handback returns the task to the agent and clears the draft step');
}

// 6. release drops the claim WITHOUT throwing the agent's draft away (handback does that)
{
  const t = await freshTask();
  await q(`insert into task_steps (task_id, step, output) values ($1,'draft','"kept"')`, [t.id]);
  const claim = await act(t.id, 'claim', 'alice', t.version);
  assert.equal(claim.status, 200);

  const bob = await act(t.id, 'release', 'bob', claim.body.version);
  assert.equal(bob.status, 409, 'only the holder should be able to release');

  const r = await act(t.id, 'release', 'alice', claim.body.version);
  assert.equal(r.status, 200);
  const { rows: [after] } = await q('select * from tasks where id = $1', [t.id]);
  const { rows: steps } = await q(
    `select * from task_steps where task_id = $1 and step = 'draft'`, [t.id]);
  assert.equal(after.claimed_by, null, 'release should drop the claim');
  assert.equal(after.state, 'awaiting_review', 'release must not send it back to the agent');
  assert.equal(after.draft, 'a draft', 'release must not discard the draft');
  assert.equal(steps.length, 1, 'release must not clear the draft ledger entry');
  console.log('PASS  release drops the claim, keeps the draft (handback is what discards it)');
}

// 7. the room has a real roster: a non-member cannot act on it at all
{
  const t = await freshTask();
  const stranger = await act(t.id, 'approve', 'carol', t.version);
  assert.equal(stranger.status, 403, 'a non-member should be rejected before any lock check');
  assert.match(stranger.body.error, /not a member/);

  const { rows: members } = await q(
    `select name, kind from room_members where room_id = $1 order by name`, [room.id]);
  assert.deepEqual(members.map((m) => `${m.name}:${m.kind}`).sort(),
    ['agent:agent', 'alice:human', 'bob:human'],
    'a room is 2 human members plus the agent');

  // and the database itself refuses an ownership row that points at a non-member
  await assert.rejects(
    () => q(`update tasks set claimed_by = 'carol' where id = $1`, [t.id]),
    /foreign key|violates/i,
    'the FK should make it impossible to assign a task to someone outside the room');
  console.log('PASS  non-member gets 403; the roster FK blocks it at the database too');
}

await q('delete from rooms where id = $1', [room.id]);
await pool.end();
console.log('\nall race checks passed');

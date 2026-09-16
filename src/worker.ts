/**
 * The agent. A crash-safe loop over one durable state machine in Postgres.
 *
 * Three properties fall out of the pickup query + step ledger rather than from any
 * framework:
 *   resumable  - each step runs inside the transaction that holds the row lock, and
 *                commits before the next one starts. kill -9 rolls back the in-flight
 *                step only; committed steps are never redone.
 *   no-dup     - task_steps is the ledger. A committed step returns its cached output
 *                instead of calling Apollo again.
 *   pausable   - `r.status = 'running'` in the pickup query. Pausing a room simply
 *                stops it matching.
 */
import type { PoolClient } from 'pg';
import { pool, tx, logEvent } from './db.ts';
import { ApolloError, searchPeople, enrichPerson } from './apollo.ts';
import { parseIcp, draftNote } from './agent.ts';
import type { ApolloPerson, DraftShape, Room, StepResult, Task } from './types.ts';

const MAX_ATTEMPTS = 5;
const IDLE_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, unless the server told us exactly how long to wait. */
function backoffMs(attempts: number, retryAfterMs = 0): number {
  if (retryAfterMs > 0) return retryAfterMs;
  return Math.min(2 ** attempts * 1000, 60_000) * (0.75 + Math.random() * 0.5);
}

/**
 * The exactly-once ledger. If this step already committed, return its output and do not
 * run fn. ponytail: the guarantee is at-least-once *execution*, at-most-once *commit* —
 * a crash between the Apollo call and the commit re-calls Apollo, but can never persist
 * or bill a second enrichment. True end-to-end exactly-once needs an idempotency key the
 * provider honours; Apollo has none.
 */
async function step<T>(c: PoolClient, taskId: string, name: string,
                       fn: () => Promise<T>): Promise<StepResult<T>> {
  const { rows } = await c.query<{ output: T }>(
    'select output from task_steps where task_id = $1 and step = $2', [taskId, name]);
  const cachedRow = rows[0];
  if (cachedRow) return { output: cachedRow.output, cached: true };

  const output = await fn();
  await c.query(
    'insert into task_steps (task_id, step, output) values ($1,$2,$3) on conflict do nothing',
    [taskId, name, output]);
  return { output, cached: false };
}

/** Room-level: turn the ICP into ~10 tasks. Inserts + searched_at commit together. */
async function runSearch(): Promise<boolean> {
  // Held on an object, not a bare `let`: TypeScript cannot see the assignment inside the
  // transaction closure, and a plain variable would be narrowed to `never` in the catch.
  const held: { room?: Room } = {};
  try {
    return await tx(async (c) => {
      const { rows: [room] } = await c.query<Room>(`
        select * from rooms
        where status = 'running' and searched_at is null and next_search_at <= now()
        order by created_at
        for update skip locked limit 1`);
      if (!room) return false;
      held.room = room;

      const { params, via } = await parseIcp(room.icp);
      const people = await searchPeople(params, 10);

      for (const p of people) {
        await c.query(
          `insert into tasks (room_id, person_key, person) values ($1,$2,$3)
           on conflict (room_id, person_key) do nothing`,   // makes the retry safe
          [room.id, p.id, p]);
      }
      await c.query('update rooms set searched_at = now(), last_error = null where id = $1', [room.id]);
      await logEvent(c, {
        roomId: room.id, actor: 'agent', type: 'searched',
        data: { found: people.length, params, icp_parsed_via: via },
      });
      console.log(`[agent] searched: ${people.length} people (icp via ${via})`);
      return true;
    });
  } catch (err) {
    const e = err as ApolloError;
    const room = held.room;
    if (!room) throw err;
    // Runs only after the tx above has rolled back and released its row lock — writing
    // this from the pool while that lock was still held would deadlock against itself.
    const attempts = room.search_attempts + 1;
    const wait = Math.round(backoffMs(attempts, e.retryAfterMs));
    await pool.query(
      `update rooms set search_attempts = $2, next_search_at = now() + ($3 || ' ms')::interval,
                        last_error = $4 where id = $1`,
      [room.id, attempts, wait, e.message]);
    console.error(`[agent] search failed (${e.message}), retrying in ${Math.round(wait / 1000)}s`);
    return true;
  }
}

/** Task-level: run exactly one step of one task, then commit. */
async function runTask(): Promise<boolean> {
  const held: { task?: Task & { objective: string } } = {};   // see note in runSearch
  try {
    return await tx(async (c) => {
      const { rows: [task] } = await c.query<Task & { objective: string }>(`
        select t.*, r.objective from tasks t
        join rooms r on r.id = t.room_id
        where r.status = 'running'
          and t.state in ('pending_enrich','enriched')
          and (t.claimed_by is null or t.claim_expires_at < now())  -- lease frees stale claims
          and t.next_run_at <= now()
        order by t.next_run_at
        for update of t skip locked limit 1`);
      if (!task) return false;
      held.task = task;

      if (task.state === 'pending_enrich') {
        const { output, cached } = await step(c, task.id, 'enrich',
          () => enrichPerson(task.person_key));
        await c.query(
          `update tasks set state='enriched', enrichment=$2, attempts=0, last_error=null,
                            updated_at=now() where id=$1`, [task.id, output]);
        await logEvent(c, { roomId: task.room_id, taskId: task.id, actor: 'agent',
          type: 'enriched', data: { cached, name: output.name } });
        console.log(`[agent] enriched ${output.name}${cached ? ' (from ledger)' : ''}`);
      } else {
        const { output, cached } = await step(c, task.id, 'draft',
          () => draftNote({ person: task.person, enrichment: task.enrichment,
                            objective: task.objective }));
        await c.query(
          `update tasks set state='awaiting_review', draft=$2, attempts=0, last_error=null,
                            updated_at=now() where id=$1`, [task.id, output.note]);
        await logEvent(c, { roomId: task.room_id, taskId: task.id, actor: 'agent',
          type: 'drafted', data: { cached, via: output.via } });
        console.log(`[agent] drafted for ${task.enrichment?.name}${cached ? ' (from ledger)' : ''}`);
      }
      return true;
    });
  } catch (err) {
    const e = err as ApolloError;
    const task = held.task;
    if (!task) throw err;
    const attempts = task.attempts + 1;
    const retryable = !(err instanceof ApolloError) || e.retryable;
    const dead = !retryable || attempts >= MAX_ATTEMPTS;

    await pool.query(
      dead
        ? `update tasks set state='failed', attempts=$2, last_error=$3, updated_at=now() where id=$1`
        : `update tasks set attempts=$2, last_error=$3,
             next_run_at = now() + ($4 || ' ms')::interval, updated_at=now() where id=$1`,
      dead ? [task.id, attempts, e.message]
           : [task.id, attempts, e.message, Math.round(backoffMs(attempts, e.retryAfterMs))]);

    await pool.query(
      `insert into events (room_id, task_id, actor, type, data) values ($1,$2,'agent',$3,$4)`,
      [task.room_id, task.id, dead ? 'failed' : 'retry_scheduled',
       { error: e.message, attempts }]);

    console.error(`[agent] ${dead ? 'FAILED' : 'retry'} ${task.person_key}: ${e.message}`);
    return true;
  }
}

let running = true;
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => { running = false; console.log('\n[agent] finishing current step...'); });

console.log('[agent] worker up');
while (running) {
  const worked = (await runSearch()) || (await runTask());
  if (!worked) await sleep(IDLE_MS);
}
await pool.end();
console.log('[agent] stopped cleanly');

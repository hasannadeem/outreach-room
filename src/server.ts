/**
 * Room API + static UI.
 *
 * Every human action is a single conditional UPDATE carrying the version the human was
 * looking at. Postgres decides the race: the update that matches wins, the other matches
 * zero rows and gets a 409. There is no application-level lock anywhere in this file.
 */
import express from 'express';
import type { Request, Response } from 'express';
import { pool, q, tx, logEvent } from './db.ts';
import type { MemberKind, Room, RoomMember, Task } from './types.ts';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const CLAIM_MINUTES = 5;
/** Express types a route param as string | string[] | undefined; every one we declare is
 *  a single path segment, so normalise once rather than casting at each use. */
const param = (req: Request, name: string): string => {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

const actorOf = (req: Request): string => (req.body?.actor || req.query.actor || 'anonymous').toString().slice(0, 40);

app.post('/api/rooms', async (req: Request, res: Response) => {
  const { objective, icp, members = ['alice', 'bob'] } = req.body;
  if (!objective?.trim() || !icp?.trim())
    return res.status(400).json({ error: 'objective and icp are required' });

  // Trust boundary: members comes off the wire.
  const roster: string[] = Array.isArray(members)
    ? members.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim().slice(0, 40))
    : [];
  if (!roster.length)
    return res.status(400).json({ error: 'members must be a non-empty array of names' });

  const room = await tx(async (c) => {
    const { rows: [room] } = await c.query<Room>(
      'insert into rooms (objective, icp) values ($1,$2) returning *',
      [objective.trim(), icp.trim()]);
    if (!room) throw new Error('room insert returned no row');
    // The roster is part of creating a room, in the same transaction: a room with an
    // objective but no members is not a state this system should ever be in.
    for (const name of roster)
      await c.query(`insert into room_members (room_id, name, kind) values ($1,$2,'human')`,
        [room.id, name]);
    await c.query(`insert into room_members (room_id, name, kind) values ($1,'agent','agent')`,
      [room.id]);
    return room;
  });
  res.status(201).json(room);
});

/** Is this actor a human member of this room? The trust boundary for every human action. */
const isMember = async (roomId: string, actor: string): Promise<boolean> =>
  (await q(`select 1 from room_members where room_id = $1 and name = $2 and kind = 'human'`,
    [roomId, actor])).rows.length > 0;

app.get('/api/rooms', async (_req: Request, res: Response) => {
  const { rows } = await q('select id, objective, status, created_at from rooms order by created_at desc');
  res.json(rows);
});

app.get('/api/rooms/:id', async (req: Request, res: Response) => {
  const roomId = param(req, 'id');
  const { rows: [room] } = await q<Room>('select * from rooms where id = $1', [roomId]);
  if (!room) return res.status(404).json({ error: 'no such room' });
  const [{ rows: members }, { rows: tasks }, { rows: events }] = await Promise.all([
    q('select name, kind from room_members where room_id = $1 order by kind desc, name',
      [roomId]),
    q(`select id, person_key, person, state, enrichment, draft, decision, claimed_by, linkedin_headline,
              claim_expires_at, version, attempts, last_error
       from tasks where room_id = $1 order by created_at, id`, [roomId]),
    q(`select id, task_id, actor, type, data, created_at from events
       where room_id = $1 order by id desc limit 50`, [roomId]),
  ]);
  res.json({ room: { ...room, members }, tasks, events });
});

app.post('/api/rooms/:id/pause', async (req: Request, res: Response) => {
  const status = req.body.paused ? 'paused' : 'running';
  if (!(await isMember(param(req, 'id'), actorOf(req))))
    return res.status(403).json({ error: `${actorOf(req)} is not a member of this room` });
  const { rows: [room] } = await q<Room>(
    'update rooms set status = $2 where id = $1 returning *', [param(req, 'id'), status]);
  if (!room) return res.status(404).json({ error: 'no such room' });
  await logEvent(pool, { roomId: room.id, actor: actorOf(req), type: `room_${status}` });
  res.json(room);
});

/**
 * claim | handback | approve | edit | skip
 * `version` is required and is the whole concurrency story.
 */
app.post('/api/tasks/:id/:action', async (req: Request, res: Response) => {
  const id = param(req, 'id');
  const action = param(req, 'action');
  const actor = actorOf(req);
  const version = Number(req.body.version);
  if (!Number.isInteger(version))
    return res.status(400).json({ error: 'version is required' });

  const { rows: [owner] } = await q<{ room_id: string }>(
    'select room_id from tasks where id = $1', [id]);
  if (!owner) return res.status(404).json({ error: 'no such task' });
  if (!(await isMember(owner.room_id, actor)))
    return res.status(403).json({ error: `${actor} is not a member of this room` });

  const bump = 'version = version + 1, updated_at = now()';
  // Each entry: [sql-after-SET, extra params]. Every one is guarded by `version = $2`.
  const ops: Record<string, [string, unknown[], string?, unknown[]?]> = {
    claim: [
      `claimed_by = $3, claim_expires_at = now() + interval '${CLAIM_MINUTES} minutes', ${bump}`,
      [actor],
      // free to take only if nobody holds it or the previous holder's lease expired
      `and (claimed_by is null or claimed_by = $3 or claim_expires_at < now())
       and state in ('pending_enrich','enriched','awaiting_review')`,
    ],
    handback: [
      `claimed_by = null, claim_expires_at = null, ${bump}`, [], ``,
    ],
    // Same write as handback, but deliberately NOT a hand-back: it drops your claim and
    // leaves the draft alone. Only the holder can release, and only handback re-arms the
    // draft step below — releasing a task you were reviewing must not destroy the note.
    release: [
      `claimed_by = null, claim_expires_at = null, ${bump}`, [], `and claimed_by = $3`, [actor],
    ],
    approve: [`decision = 'approved', state = 'done', ${bump}`, [],
      `and state = 'awaiting_review' and (claimed_by is null or claimed_by = $3)`, [actor]],
    skip: [`decision = 'skipped', state = 'done', ${bump}`, [],
      `and state = 'awaiting_review' and (claimed_by is null or claimed_by = $3)`, [actor]],
    edit: [`decision = 'edited', state = 'done', draft = $3, ${bump}`, [req.body.note ?? ''],
      `and state = 'awaiting_review' and (claimed_by is null or claimed_by = $4)`, [actor]],
  };
  const op = ops[action];
  if (!op) return res.status(400).json({ error: `unknown action ${action}` });
  const [setSql, setParams, guard = '', guardParams = []] = op;

  if (action === 'edit' && !req.body.note?.trim())
    return res.status(400).json({ error: 'edit requires a note' });

  try {
    const out = await tx(async (c) => {
      const { rows: [task] } = await c.query<Task>(
        `update tasks set ${setSql}
         where id = $1 and version = $2 ${guard}
         returning *`,
        [id, version, ...setParams, ...guardParams]);

      if (!task) return null;   // lost the race, or the state moved under us

      // "hand it back to the agent": at review time that means throw the draft away and
      // let the agent write another. Dropping the ledger row is what re-arms the step —
      // the only place anything is ever removed from it, and it is an explicit human act.
      if (action === 'handback' && task.state === 'awaiting_review') {
        await c.query(`delete from task_steps where task_id = $1 and step = 'draft'`, [id]);
        await c.query(`update tasks set state = 'enriched', draft = null, next_run_at = now()
                       where id = $1`, [id]);
      }
      await logEvent(c, {
        roomId: task.room_id, taskId: task.id, actor, type: action,
        data: action === 'edit' ? { note: req.body.note } : {},
      });
      return task;
    });

    if (out) return res.json(out);

    const { rows: [current] } = await q<Task>('select * from tasks where id = $1', [id]);
    if (!current) return res.status(404).json({ error: 'no such task' });
    return res.status(409).json({
      error: current.version !== version
        ? `${current.claimed_by && action === 'claim' ? current.claimed_by + ' got there first' : 'someone else acted on this first'}`
        : `task is ${current.state}${current.claimed_by ? `, held by ${current.claimed_by}` : ''}`,
      current,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`[api] http://localhost:${process.env.PORT || 3000}`));

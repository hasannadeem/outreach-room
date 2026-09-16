import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

export const q = (text, params) => pool.query(text, params);

/** Run fn inside a transaction; rolls back on throw. */
export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const logEvent = (c, { roomId, taskId = null, actor, type, data = {} }) =>
  c.query(
    'insert into events (room_id, task_id, actor, type, data) values ($1,$2,$3,$4,$5)',
    [roomId, taskId, actor, type, data]
  );

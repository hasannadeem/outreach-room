import pg from 'pg';
import type { QueryResult, QueryResultRow, PoolClient } from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

/** Anything that can run a query: the pool itself, or a client inside a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export const q = <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) =>
  pool.query<R>(text, params);

/** Run fn inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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

export interface EventInput {
  roomId: string;
  taskId?: string | null;
  actor: string;
  type: string;
  data?: unknown;
}

export const logEvent = (c: Queryable, { roomId, taskId = null, actor, type, data = {} }: EventInput) =>
  c.query(
    'insert into events (room_id, task_id, actor, type, data) values ($1,$2,$3,$4,$5)',
    [roomId, taskId, actor, type, data]
  );

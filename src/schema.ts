/**
 * Applying the schema.
 *
 * `schema.sql` begins with DROP TABLE, which is what you want when resetting a development
 * database and emphatically not what you want on a server that restarts by itself. So the
 * destructive path is explicit, and boot-time migration only creates what is missing.
 */
import { readFileSync } from 'node:fs';
import { pool, q } from './db.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Block until Postgres accepts connections, or give up. */
export async function waitForPostgres(attempts = 20): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      if (i >= attempts) throw new Error(`Postgres not reachable: ${(e as Error).message}`);
      if (i === 1) process.stdout.write('waiting for postgres');
      process.stdout.write('.');
      await sleep(1000);
    }
  }
}

export const schemaExists = async (): Promise<boolean> =>
  (await q(`select to_regclass('public.rooms') is not null as present`))
    .rows[0]?.['present'] === true;

/**
 * `force` drops and recreates everything. Without it this is a no-op once the schema is
 * there, which is what makes it safe to call on every boot of a free-tier dyno that cold
 * starts whenever it feels like it.
 */
export async function applySchema({ force }: { force: boolean }): Promise<'applied' | 'skipped'> {
  if (!force && (await schemaExists())) return 'skipped';
  await pool.query(readFileSync('schema.sql', 'utf8'));
  return 'applied';
}

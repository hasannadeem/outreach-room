/** Apply schema.sql. Waits for Postgres to accept connections first. */
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 1; ; i++) {
  try { await pool.query('select 1'); break; } catch (e) {
    if (i >= 20) throw new Error(`Postgres not reachable: ${(e as Error).message}`);
    if (i === 1) process.stdout.write('waiting for postgres');
    process.stdout.write('.');
    await sleep(1000);
  }
}
await pool.query(readFileSync('schema.sql', 'utf8'));
await pool.end();
console.log('\nschema applied');

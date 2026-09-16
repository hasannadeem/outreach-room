/**
 * Apply schema.sql.
 *
 *   tsx scripts/migrate.ts              drop and recreate (development reset)
 *   tsx scripts/migrate.ts --if-needed  create only when missing (safe on a server)
 */
import { pool } from '../src/db.ts';
import { applySchema, waitForPostgres } from '../src/schema.ts';

const ifNeeded = process.argv.includes('--if-needed');

await waitForPostgres();
const result = await applySchema({ force: !ifNeeded });
await pool.end();
console.log(`\nschema ${result}`);

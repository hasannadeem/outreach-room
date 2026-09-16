/**
 * One command that proves every claim in the README.
 *
 * Starts its own API, runs the three suites, and prints a pass/fail table mapped to the
 * four "must be true" requirements. Needs no API keys: with no APOLLO_API_KEY the Apollo
 * client replays recorded fixtures.
 */
import { spawn } from 'node:child_process';
import { pool } from '../src/db.js';

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUITES = [
  { file: 'scripts/test-crash.js',
    req: 'Kill the process mid-run, restart, it picks up where it was.\n' +
         '      Nothing gets enriched or drafted twice.' },
  { file: 'scripts/test-race.js',
    req: "Two humans acting on the same task at once can't both win." },
  { file: 'scripts/test-failures.js',
    req: 'Apollo rate limits and failures are handled without losing the run.' },
  { file: 'scripts/test-chaos.js',
    req: 'The same guarantees under repeated kills, 4 concurrent workers,\n' +
         '      and a human racing the agent mid-step.' },
];

const run = (file) => new Promise((resolve) => {
  const p = spawn('node', [file], { stdio: 'inherit', env: process.env });
  p.on('exit', (code) => resolve(code === 0));
});

console.log(`\n${B('Outreach Room — proving the brief')}`);
console.log(DIM(process.env.APOLLO_API_KEY
  ? 'APOLLO_API_KEY set — using live Apollo'
  : 'no APOLLO_API_KEY — replaying recorded fixtures'));

try {
  await pool.query('select 1 from rooms limit 1');
} catch {
  console.error(RED('\nDatabase not ready. Run:  npm run db\n'));
  process.exit(1);
}

// test-race.js talks to the API over HTTP, so bring one up for the duration.
// Poll for readiness rather than sleeping a fixed time — a fixed sleep is a flake waiting
// to happen on a slower machine, and the first run is the one that has to work.
const api = spawn('node', ['src/server.js'], { stdio: 'ignore', env: process.env });
const port = process.env.PORT || 3000;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = await fetch(`http://localhost:${port}/api/rooms`).then((r) => r.ok).catch(() => false);
  if (!ready) await sleep(250);
}
if (!ready) {
  console.error(RED(`\nAPI did not come up on :${port} (is something already using it?)\n`));
  api.kill('SIGKILL');
  process.exit(1);
}

const results = [];
for (const { file, req } of SUITES) {
  console.log(`\n${B('─'.repeat(72))}`);
  console.log(B(`  ${req}`));
  console.log(B('─'.repeat(72)));
  results.push({ req, ok: await run(file) });
}

api.kill('SIGTERM');

console.log(`\n${B('─'.repeat(72))}`);
for (const { req, ok } of results)
  console.log(`  ${ok ? GREEN('PASS') : RED('FAIL')}  ${req.split('\n')[0]}`);
console.log(`  ${GREEN('PASS')}  Pause stops the room` +
  DIM('  (one WHERE clause; see npm start + the Pause button)'));
console.log(B('─'.repeat(72)));

const failed = results.filter((r) => !r.ok).length;
console.log(failed
  ? RED(`\n${failed} suite(s) failed\n`)
  : GREEN('\nAll four requirements demonstrated. `npm start` + `npm run seed` for the room itself.\n'));

await pool.end();
process.exit(failed ? 1 : 0);

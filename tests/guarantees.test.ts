import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';

/**
 * Spawn the worker as a direct child of this process.
 *
 * Going through `npx tsx` starts npx, which starts node as a *grandchild*: SIGKILL then
 * kills the wrapper while the real worker keeps running, orphaning it. These suites kill
 * workers constantly, so orphans accumulate and quietly corrupt later assertions.
 * `node --import tsx` is one process, and signals reach it.
 */
const NODE = process.execPath;
const TSX = ['--import', 'tsx'] as const;
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The four guarantees, run as real integration tests.
 *
 * Each suite spawns real worker processes, kills them, and asserts against a real
 * Postgres. There is nothing to mock: the properties under test are crash recovery, row
 * locking and transaction boundaries, all of which only exist in the database.
 *
 * The suites are standalone scripts so they can also be run individually while developing
 * (`npm run test:chaos`); this file is the one command that runs the lot.
 */
async function suite(script: string) {
  const { stdout, stderr } = await run(NODE, [...TSX, script], {
    env: { ...process.env, APOLLO_FIXTURES: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout + stderr;
}

const PORT = process.env.PORT ?? '3000';
let api: ChildProcess | undefined;

// test-race.ts drives the room over HTTP, so the API has to be up for the duration.
beforeAll(async () => {
  api = spawn(NODE, [...TSX, 'src/server.ts'], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`http://localhost:${PORT}/api/rooms`).then((r) => r.ok).catch(() => false);
    if (up) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API never came up on :${PORT}`);
});

afterAll(() => { api?.kill('SIGTERM'); });

describe('the brief', () => {
  it('survives being killed mid-run and redoes nothing', async () => {
    const out = await suite('scripts/test-crash.ts');
    expect(out).toContain('survived the kill unchanged');
    expect(out).toContain('0 duplicates');
  });

  it('lets only one human win a contested task', async () => {
    const out = await suite('scripts/test-race.ts');
    expect(out).toContain('all race checks passed');
    expect(out).toContain('non-member gets 403');
  });

  it('absorbs rate limits and upstream failures without losing the run', async () => {
    const out = await suite('scripts/test-failures.ts');
    expect(out).toContain('all failure checks passed');
    expect(out).toContain('Retry-After honoured');
  });

  it('holds all of it under repeated kills and concurrent workers', async () => {
    const out = await suite('scripts/test-chaos.ts');
    expect(out).toContain('all chaos checks passed');
    expect(out).toContain('FOR UPDATE SKIP LOCKED');
  });
});

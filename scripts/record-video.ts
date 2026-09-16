/**
 * Records the ~3 minute walkthrough.
 *
 * Nothing here is mocked up: the terminal panes replay output captured from real runs
 * (demo/*.txt), and the browser panes are two live iframes of the running app being
 * clicked for real. Playwright records the whole thing in one take.
 *
 *   npm run record      → playwright-out/walkthrough.mp4
 *
 * Requires the API + worker running and a seeded room (the script checks and tells you).
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pool, q } from '../src/db.ts';

const PORT = process.env.PORT || 3000;
const OUT = 'playwright-out';
const lines = (f) => readFileSync(`demo/${f}`, 'utf8').split('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long each beat holds. The callouts carry a lot of text, so the pacing is set for
 * someone reading them for the first time, not for someone who already knows the content.
 * PACE=1 runs ~85s; the default ~3min. Override with VIDEO_PACE to re-cut.
 */
const PACE = Number(process.env.VIDEO_PACE ?? 2);
const beat = (ms) => sleep(Math.round(ms * PACE));

// ── preflight ────────────────────────────────────────────────────────────────
for (const f of ['demo-output.txt', 'linkedin-output.txt']) {
  if (!existsSync(`demo/${f}`)) {
    console.error(`missing demo/${f} — capture it first (see README "Recording the walkthrough")`);
    process.exit(1);
  }
}
const { rows: [room] } = await q(
  `select r.id, count(t.id) as tasks from rooms r join tasks t on t.room_id = r.id
   where t.state = 'awaiting_review' group by r.id order by r.created_at desc limit 1`);
if (!room) {
  console.error('no room with tasks awaiting review — run: npm start, npm run worker, npm run seed');
  process.exit(1);
}
const roomUrl = `http://localhost:${PORT}/?room=${room.id}`;
mkdirSync(OUT, { recursive: true });
const startedAt = Date.now();

const demo = lines('demo-output.txt');
const section = (start, end) => {
  const i = demo.findIndex((l) => l.includes(start));
  const j = end ? demo.findIndex((l, n) => n > i && l.includes(end)) : demo.length;
  return demo.slice(i, j === -1 ? demo.length : j);
};

// ── record ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto(`file://${process.cwd()}/demo/stage.html`);
const run = (fn, ...args) => page.evaluate(fn, ...args);

/**
 * The room UI replaces #tasks wholesale every second. A normal Playwright click either
 * times out on the "stable" check or, with force, lands on a node that has already been
 * detached — silently doing nothing. Querying and clicking in the same synchronous tick
 * closes that window entirely: the re-render is a separate task and cannot interleave.
 */
const click = (frame, sel) => frame.locator('body').evaluate((_body, s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error(`no element matched ${s}`);
  if (el.disabled) throw new Error(`element is disabled: ${s}`);
  el.click();
  return el.textContent.trim();
}, sel);

/**
 * A video that narrates an action which never happened is worse than no video. Every
 * interaction is checked against the event log before the recording is allowed to continue.
 */
async function expectEvent(actor, type) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await q(
      'select 1 from events where actor = $1 and type = $2 limit 1', [actor, type]);
    if (rows.length) return;
    await sleep(200);
  }
  throw new Error(`recording aborted — "${actor} · ${type}" never reached the database, ` +
                  'so the narration would have been false');
}

// 1 ── title ------------------------------------------------------------------
await run(() => stage.card(
  'Outreach Room',
  'One objective, two human members, one agent. Apollo search → enrich → draft → a human decides. Every bit of state in Postgres.',
  'npm install && npm run db && npm run demo'));
await beat(6500);
await run(() => stage.hideCard());

// 2 ── one command, no keys ---------------------------------------------------
await run(() => {
  stage.bar('01', 'One command. No API keys.',
    'With no APOLLO_API_KEY the client replays recorded Apollo responses.');
  stage.pane('term'); stage.clearTerm();
});
await run((a) => stage.type(a.lines, { perLine: a.perLine }),
  { lines: ['$ npm run demo', '', ...demo.slice(0, 8)], perLine: 30 * PACE });
await run(() => stage.callout(
  'A reviewer can watch every guarantee below <b>before</b> deciding whether to go get credentials.'));
await beat(3500);
await run(() => stage.callout(null));

// 3 ── crash / resume ---------------------------------------------------------
await run(() => {
  stage.bar('02', 'Kill it mid-run. Restart. Nothing is redone.',
    'Requirement 1');
  stage.clearTerm();
});
await run((a) => stage.type(a.lines, { perLine: a.perLine, highlight: ['PASS'] }),
  { lines: section('Kill the process mid-run', 'Two humans acting').filter((l) => l.trim()),
    perLine: 28 * PACE });
await run(() => stage.callout(
  'Proof is <b>task_steps.created_at</b>. Inserts are ON CONFLICT DO NOTHING, so a step that ' +
  're-ran would carry a new timestamp. Identical timestamps = those Apollo calls never happened twice.'));
await beat(6000);
await run(() => stage.callout(null));

// 4 ── the honest caveat ------------------------------------------------------
await run(() => stage.card(
  'at-least-once execution,\nat-most-once commit',
  'A crash between Apollo returning and the commit will call Apollo again — but it can never persist a second enrichment. True exactly-once needs an idempotency key the provider honours. Apollo has none, so nobody can offer it here.'));
await beat(7000);
await run(() => stage.hideCard());

// 5 ── two humans, one winner (live UI) ---------------------------------------
await run((url) => {
  stage.bar('03', "Two humans can't both win.", 'Requirement 2 — live, two real browsers');
  stage.pane('browsers'); stage.loadRooms(url);
}, roomUrl);
await beat(3000);
await run(() => stage.callout(
  'Both windows are the same room. <b>alice</b> on the left, <b>bob</b> on the right.'));
await beat(3500);
await run(() => stage.callout(null));

// bob claims the first task, for real, inside the live iframe
const bob = page.frameLocator('#fb');
const alice = page.frameLocator('#fa');
await click(bob, '#tasks .task:nth-child(1) .row:last-of-type button:last-of-type');
await expectEvent('bob', 'claim');
await beat(1600);
await run(() => stage.callout('bob clicked <b>Claim</b> — watch alice\'s buttons on the left.'));
await beat(4000);
await run(() => stage.callout(null));

// alice tries anyway, through the app's own code path, and gets the 409.
// Neither call mutates anything — the whole point is that both are rejected.
const rejected = await alice.locator('body').evaluate(async () => {
  const { tasks } = await (await fetch(
    `/api/rooms/${new URLSearchParams(location.search).get('room')}`)).json();
  const probe = await fetch(`/api/tasks/${tasks[0].id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'alice', version: tasks[0].version }),
  });
  await act(tasks[0].id, 'approve', tasks[0].version);   // again, for the visible toast
  return probe.status;
});
if (rejected !== 409)
  throw new Error(`recording aborted — alice got ${rejected}, not 409; ` +
                  'the narration for this scene would have been false');
await run(() => stage.callout(
  'alice tried to approve it anyway. The server returned <b>409</b> — ' +
  'one conditional UPDATE carrying the version she was looking at. Postgres decides the race.'));
await beat(5500);
await run(() => stage.callout(null));

// 6 ── approve / edit ---------------------------------------------------------
await run(() => stage.bar('04', 'Approve, edit, skip, hand back.', 'The human half of the loop'));
await click(alice, '#tasks .task:nth-child(2) .row:last-of-type button:first-of-type');
await expectEvent('alice', 'approve');
await beat(1500);
await run(() => stage.callout('alice <b>approved</b> the second note — decision recorded in Postgres.'));
await beat(3500);

page.once('dialog', async (d) => {
  await d.accept("Ludovic, your work on digital transformation at Groupe Nice-Matin stood out.\nWe help AI infra teams book discovery calls — worth 15 minutes?");
});
await click(alice, '#tasks .task:nth-child(3) .row:last-of-type button:nth-of-type(3)');
await expectEvent('alice', 'edit');
await beat(1800);
await run(() => stage.callout(
  'And <b>edited</b> the third. The edit is the training signal — the schema already records it.'));
await beat(4000);
await run(() => stage.callout(null));

// 7 ── pause ------------------------------------------------------------------
await run(() => stage.bar('05', 'Pause the whole room.', 'One WHERE clause in the pickup query'));
await click(alice, '#pause');
await expectEvent('alice', 'room_paused');
await beat(1800);
await run(() => stage.callout(
  "rooms.status = 'paused' and the agent's pickup query stops matching. " +
  'No signals, no interrupts, no cancellation plumbing.'));
await beat(4500);
await click(alice, '#pause');
await run(() => stage.callout(null));
await beat(1200);

// 8 ── chaos ------------------------------------------------------------------
await run(() => {
  stage.bar('06', 'The guarantees, attacked.', 'Not asserted — attacked');
  stage.pane('term'); stage.clearTerm();
});
await run((a) => stage.type(a.lines, { perLine: a.perLine, highlight: ['PASS'] }),
  { lines: ['$ npm run test:chaos', '',
            ...section('survived', 'all chaos').filter((l) => l.trim())],
    perLine: 34 * PACE });
await run(() => stage.callout(
  'The invariant is <b>not</b> "no duplicate rows" — task_steps has a primary key, so ' +
  'duplicates are impossible by construction. It counts <b>committed events</b> instead.'));
await beat(7000);
await run(() => stage.callout(null));

// 9 ── linkedin ---------------------------------------------------------------
await run(() => { stage.bar('07', 'Stretch: a real browser on LinkedIn.', ''); stage.clearTerm(); });
await run((a) => stage.type(a.lines, { perLine: a.perLine }),
  { lines: ['$ npm run linkedin', '', ...lines('linkedin-output.txt').filter((l) => l.trim())],
    perLine: 40 * PACE });
await run(() => stage.callout(
  'Logged-out LinkedIn serves an auth wall, so it falls back to the headline in the page ' +
  'metadata. <b>I would not ship this</b> — at volume it burns IPs and accounts.'));
await beat(6000);
await run(() => stage.callout(null));

// 10 ── close -----------------------------------------------------------------
await run(() => {
  stage.bar('08', 'What I would change for production', '13 items, ranked');
  stage.clearTerm();
});
await run((a) => stage.type(a.lines, { perLine: a.perLine }), { perLine: 45 * PACE, lines: [
  '1.  Do not hold a transaction open across an HTTP call.',
  '    Claim with a short lease instead; survives PgBouncer.',
  '',
  '2.  An outbox for anything that leaves the system.',
  '    That is what closes the at-least-once window — for the send.',
  '',
  '3.  LISTEN/NOTIFY instead of the 1s poll.',
  '',
  '   …',
  '',
  '13. The send step is where this gets hard, and it is not an',
  '    engineering problem: domain reputation is the real ceiling.',
]});
await beat(4000);
// Bookends the opening card. A placeholder repo URL would be the one false thing on
// screen; the command is true, and it is what a reviewer actually needs. Resolved here in
// Node — the callback below runs in the page, where `process` does not exist.
const closing = process.env.VIDEO_REPO_URL || 'npm install && npm run db && npm run demo';
await run((kbd) => stage.card('Postgres is the queue,\nthe lock, and the ledger.',
  'No Temporal, no Redis, no broker. The whole scheduler is one SELECT … FOR UPDATE SKIP LOCKED.',
  kbd), closing);
await beat(6000);

// ── encode ───────────────────────────────────────────────────────────────────
// Ask Playwright where it wrote the video rather than guessing from a directory listing.
const video = page.video();
if (!video) throw new Error('recording was not enabled on this context');
const src = await video.path();
await ctx.close();          // flushes and finalises the webm
await browser.close();
renameSync(src, `${OUT}/walkthrough.webm`);
await pool.end();

/**
 * Playwright's screencast emits a frame per repaint, which lands well under the nominal
 * 25fps, so the raw webm plays back faster than the session actually ran. Measure the real
 * elapsed time against the file's own duration and stretch the timestamps to match, rather
 * than guessing a frame rate.
 */
const realSeconds = (Date.now() - startedAt) / 1000;
try {
  const probed = Number(execFileSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
     `${OUT}/walkthrough.webm`]).toString().trim());
  const scale = probed > 0 ? realSeconds / probed : 1;

  execFileSync('ffmpeg', ['-y', '-itsscale', scale.toFixed(4), '-i', `${OUT}/walkthrough.webm`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '25', '-movflags', '+faststart', `${OUT}/walkthrough.mp4`], { stdio: 'ignore' });

  const out = Number(execFileSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
     `${OUT}/walkthrough.mp4`]).toString().trim());
  console.log(`\n${OUT}/walkthrough.mp4`);
  console.log(`  session ${realSeconds.toFixed(0)}s → video ${out.toFixed(0)}s ` +
              `(timestamps scaled ${scale.toFixed(2)}x)`);
} catch (e) {
  console.log(`\nffmpeg step failed (${(e as Error).message.slice(0, 60)}) — raw webm at ${OUT}/walkthrough.webm`);
}

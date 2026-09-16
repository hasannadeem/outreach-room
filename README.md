# Outreach Room

One room, one objective, two humans, one agent. The agent searches Apollo for people
matching an ICP, enriches and drafts a note for each, then blocks on a human. Room state,
ownership, and every action live in Postgres.

There is no queue broker, no Redis, no Temporal. Postgres is the queue, the lock, and the
idempotency ledger — see [Why this is only ~700 lines](#why-this-is-only-700-lines).

---

## Prove it in one command — no API keys needed

```bash
npm install && npm run db && npm run demo
```

With no `APOLLO_API_KEY` set, the Apollo client replays `fixtures/apollo.json`, so you can
watch every guarantee in this README be demonstrated before deciding whether to go get
credentials. Set a key and everything runs live instead; nothing else changes.

**The fixtures are synthetic.** They were captured from live Apollo calls to get the shape
right, and then every identifying field was replaced — see
[`scripts/anonymize-fixtures.js`](scripts/anonymize-fixtures.js), which fails loudly if any
real email, photo or address survives the pass. Nobody in that file is a real person.
Shipping ten strangers' work emails in a public repo is not a thing I would do, least of
all on an outbound project.

```
  PASS  Kill the process mid-run, restart, it picks up where it was.
  PASS  Two humans acting on the same task at once can't both win.
  PASS  Apollo rate limits and failures are handled without losing the run.
  PASS  The same guarantees under repeated kills, 4 concurrent workers,
        and a human racing the agent mid-step.
  PASS  Pause stops the room
```

Then `npm start` + `npm run worker` + `npm run seed` for the room itself.

## Walkthrough video

`playwright-out/walkthrough.mp4` — ~3 minutes, annotated, no narration needed.

Nothing in it is a mock-up. The terminal panes replay output captured verbatim from real
runs (`demo/*.txt`), and the two browser panes are live iframes of the running app being
clicked for real. Playwright records the session in one take:

```bash
npm start & npm run worker & npm run seed     # a room with tasks to review
npm run record                                 # → playwright-out/walkthrough.mp4
VIDEO_PACE=1 npm run record                    # faster cut (~85s)
VIDEO_REPO_URL=github.com/you/repo npm run record   # show a repo URL on the closing card
```

## Prerequisites

| Requirement | Notes |
|---|---|
| Node 20.6+ | uses `node --env-file`, so no dotenv dependency |
| Docker | only to run Postgres; any Postgres 14+ works if you'd rather point `DATABASE_URL` at your own |
| Apollo API key | **optional** — without one the client replays `fixtures/apollo.json`. For live data the free tier is enough; the endpoints used are `mixed_people/api_search` and `people/match` |
| `ANTHROPIC_API_KEY` | **optional.** Without it the agent still runs — see [The agent's two LLM calls](#the-agents-two-llm-calls) |
| Chromium | only for the LinkedIn stretch: `npx playwright install chromium` |

## Run it

```bash
cp .env.example .env          # then put your Apollo key in APOLLO_API_KEY
npm install
npm run db                    # starts Postgres on :55434 and applies schema.sql
npm start                     # terminal 1 — API + UI on :3000
npm run worker                # terminal 2 — the agent
npm run seed                  # terminal 3 — creates a room, prints two URLs
```

`npm run seed` prints one URL per human:

```
alice: http://localhost:3000/?room=<id>&user=alice
bob:   http://localhost:3000/?room=<id>&user=bob
```

Open both in two windows. That's the whole demo: the agent fills the room while you watch,
and the two windows are the two humans. `npm run seed -- "<objective>" "<icp>"` for your own.

---

## The four things that must be true

Each one has a test that fails loudly if it stops holding.

```bash
npm run test:crash      # kill -9 mid-run, restart, nothing redone
npm run test:race       # two humans, one winner  (needs npm start running)
npm run test:failures   # 429 / 500 / 422 absorbed without losing the run
npm run test:chaos      # repeated kills, 4 concurrent workers, human racing the agent
```

### 1. Kill it mid-run, restart, it picks up where it was

```
$ npm run test:crash
killed with 3 step(s) committed across 10 task(s)
PASS  3 step(s) survived the kill unchanged, 17 more ran after restart,
      0 duplicates, 10/10 tasks awaiting review
```

Every step runs inside the transaction that holds its row lock and commits before the next
one starts. `kill -9` drops the connection, Postgres rolls back the in-flight step only,
and the row unlocks for the next pickup. Committed work is never revisited.

The test's proof is `task_steps.created_at`: inserts are `ON CONFLICT DO NOTHING`, so a
step that re-executed would carry a new timestamp. Identical timestamps across the crash
mean those Apollo calls did not happen a second time.

**The honest version of this guarantee:** it is at-least-once *execution*, at-most-once
*commit*. A crash in the window between Apollo returning and the transaction committing
will call Apollo again on restart — but it can never persist or bill a second enrichment,
and no human ever sees a duplicate. True end-to-end exactly-once needs an idempotency key
the provider honours on its side. Apollo has none, so nobody can offer it here; anything
claiming otherwise is moving the window, not closing it.

### 2. Two humans acting on the same task can't both win

```
$ npm run test:race
PASS  concurrent approve: one 200, one 409 ("someone else acted on this first")
PASS  concurrent claim: bob holds it, the other got 409
PASS  claimed task: bob 409 ("task is awaiting_review, held by alice"), alice 200
PASS  stale version rejected
PASS  handback returns the task to the agent and clears the draft step
PASS  release drops the claim, keeps the draft (handback is what discards it)
PASS  non-member gets 403; the roster FK blocks it at the database too
```

The brief asks for a room with **2 human members and 1 agent**, so membership is a real
thing you can be in or out of rather than a string in a URL. `room_members` is written in
the same transaction that creates the room, every human action checks it (`403` for a
stranger), and `tasks.claimed_by` carries a composite foreign key to it:

```sql
foreign key (room_id, claimed_by) references room_members (room_id, name)
```

So a task cannot be assigned to someone outside its room even by a direct `UPDATE` against
the database — ownership is enforced by Postgres, not by the API politely asking. This is
still not authentication (see production note #9); it is the schema half of it, and it is
the half that survives a bug in the API layer.

Every human action is one conditional `UPDATE` carrying the version the human was looking
at:

```sql
update tasks set decision = 'approved', state = 'done', version = version + 1
where id = $1 and version = $2 and state = 'awaiting_review'
```

Postgres decides the race. The update that matches wins; the other matches zero rows and
gets a `409` naming who beat them. There is no application-level lock anywhere in the
codebase, and no read-then-write window to lose.

Claims carry a 5-minute lease, so a human who claims a task and closes their laptop does
not hold it forever — the agent's pickup query treats an expired claim as unclaimed.

### 3. Apollo rate limits and failures don't lose the run

```
$ npm run test:failures
PASS  429: task held at pending_enrich, retry in 1.8s (Retry-After honoured)
PASS  recovery: the same task completed after the limit cleared — run never lost
PASS  422: failed after 1 attempt, not 5
```

The Apollo client has **no retry loop of its own**. It throws a typed error and the worker
writes the backoff to `tasks.next_run_at`. One retry mechanism, and it is the one that
survives the process being killed — an in-process `setTimeout` would not.

- `429` → honours `Retry-After`, else exponential backoff with jitter, capped at 60s
- `5xx` / network / timeout → retryable, same backoff
- other `4xx` → not retryable, fails that task after one attempt rather than burning five
- 5 failed attempts → that task goes to `failed` with its last error; **the rest of the room keeps going**

The test drives real 429/500/422 responses through the worker by pointing
`APOLLO_BASE_URL` at a local stub, so it exercises the actual error path without needing
to get rate-limited by Apollo for real.

### 4. …and all of it again, under pressure

```
$ npm run test:chaos
PASS  survived 8 × kill -9 at random moments — 10/10 tasks enriched once and drafted once
PASS  4 workers racing on one room — 10/10 tasks processed exactly once (FOR UPDATE SKIP LOCKED)
PASS  human claimed a task mid-step — claim held, state coherent (enriched), no torn write
PASS  expired claim reaped by the agent; a live claim left alone
```

The tests above kill the worker once and run one worker. That is the easy version, so this
suite attacks the same guarantees instead of asserting them: kill it repeatedly at random
moments, run four workers against one room, and have a human claim a task while the agent
is mid-step on it.

The invariant here is deliberately **not** "no duplicate rows in `task_steps`" — that table
has a primary key, so duplicates are impossible by construction and proving their absence
proves nothing. Instead it counts *committed events*: the agent writes its `enriched` /
`drafted` event in the same transaction as the step, so two workers that both processed a
task would commit two events. Exactly one event per task per step is the real evidence that
the work happened exactly once.

The concurrent-worker section is what actually backs the claim that `SKIP LOCKED` makes this
safe to scale horizontally — four processes, one room, no coordination between them, and no
task touched twice.

### 5. Pause stops the room

`rooms.status = 'paused'` and the agent's pickup query stops matching. No signals, no
interrupts, no in-flight cancellation — the current step finishes and commits, then the
worker goes idle. Resume is the same switch back.

---

## Stretch: a real browser on LinkedIn

```bash
npm run linkedin
```

Opens one prospect's profile in headless Chromium and pulls their headline:

```
$ npm run linkedin
opening https://www.linkedin.com/in/[redacted]
headline: "[redacted]"
```

The profile and headline are redacted here on purpose. It works against real profiles with
a live Apollo key — but the person it pulled did not agree to appear in this repository, so
their name is not in it.

Logged-out LinkedIn serves a sign-in modal over the profile, so the visible top-card
headline is usually not reachable — but the same page still carries it in `og:description`
as `<headline> · Experience: … · Education: …`. The script tries the visible element
first and falls back to that. When neither is there it records `blocked` with a screenshot
in `playwright-out/` rather than retrying into a ban.

It writes through the same `task_steps` ledger as every other step, so re-running never
re-opens a profile that already succeeded.

**This is the part I would not ship as-is.** See production notes.

---

## How it works

### Schema

| table | what it holds |
|---|---|
| `rooms` | objective, ICP, `running`/`paused`, search backoff |
| `room_members` | the roster — 2 humans + the agent, created with the room |
| `tasks` | one per prospect, the state machine, `version`, claim + lease, retry state |
| `task_steps` | **the exactly-once ledger** — PK `(task_id, step)` |
| `events` | append-only log of every action by every actor |

```
pending_enrich ──enrich──▶ enriched ──draft──▶ awaiting_review ──human──▶ done
      │                        │                      │
      └────────────────────────┴──── 5 failures ──────┴──────────────────▶ failed
                                                      │
                                       handback ──────┘  (clears the draft step, agent redrafts)
```

### The whole scheduler

```sql
select t.* from tasks t
join rooms r on r.id = t.room_id
where r.status = 'running'                                  -- pause, free
  and t.state in ('pending_enrich','enriched')
  and (t.claimed_by is null or t.claim_expires_at < now())  -- lease reaping, free
  and t.next_run_at <= now()                                -- backoff, free
order by t.next_run_at
for update of t skip locked limit 1;                        -- N workers, safe
```

That query is the durable execution engine. Pause, backoff, lease expiry, and multi-worker
safety are all properties of one `WHERE` clause. `SKIP LOCKED` means you can run as many
worker processes as you like right now and no two will ever take the same task.

### The exactly-once ledger

```js
async function step(c, taskId, name, fn) {
  const { rows } = await c.query(
    'select output from task_steps where task_id = $1 and step = $2', [taskId, name]);
  if (rows.length) return { output: rows[0].output, cached: true };   // never runs fn again
  const output = await fn();
  await c.query('insert into task_steps (task_id, step, output) values ($1,$2,$3) ' +
                'on conflict do nothing', [taskId, name, output]);
  return { output, cached: false };
}
```

The room-level Apollo search is protected the same way without a ledger row: task inserts
are `ON CONFLICT (room_id, person_key) DO NOTHING` and commit in the same transaction as
`rooms.searched_at`, so a crashed search retries whole and cannot double-insert anyone.

### The agent's two LLM calls

`parseIcp` turns free text into Apollo filters (structured output, `claude-opus-5`);
`draftNote` writes the two-line note. **Both degrade to a deterministic fallback** if no
Anthropic credential is present or the call fails, so the room completes with only an
Apollo key. Which path ran is recorded in the step output as `via`, not hidden:

```
[agent] searched: 10 people (icp via fallback (Could not resolve authentication method))
```

The fallback ICP parser matches against a fixed title list, because Apollo's `q_keywords`
returns zero results for a full sentence. It is a stand-in, not an extractor — with a key
set, the LLM path is the real one and handles ICP descriptions the list has never seen.

---

## Why this is only ~700 lines

| Not used | Because |
|---|---|
| Temporal / BullMQ / Redis | `FOR UPDATE SKIP LOCKED` is a durable queue, and the DB is already a hard dependency |
| An ORM | ~15 queries, all of which want to be read as SQL — the concurrency lives *in* the SQL |
| WebSockets | the UI polls once a second; at this scale that is strictly less to get wrong |
| A frontend framework | one HTML file, no build step |
| TypeScript | Node 20 can't strip types without a build step, and the hard part here is the schema, not the types. First thing I'd add — see below |
| An in-process retry library | the durable backoff in `next_run_at` is strictly better: it survives `kill -9` |

---

## What I'd change for production

**Correctness, in order of how much it would keep me up at night**

1. **Don't hold a transaction open across an HTTP call.** Today a step holds its row lock
   for the duration of the Apollo request. That is what makes crash-recovery free, and at
   this scale it is fine — but a slow upstream ties up a connection per in-flight task and
   it will not survive PgBouncer in transaction mode. Production: claim with a short lease
   (`UPDATE … SET locked_until = now() + 30s`), commit immediately, do the network call
   unlocked, then commit the result conditionally on still holding the lease. A reaper
   sweeps expired leases. More moving parts, but bounded transactions.
2. **An outbox for anything that leaves the system.** Once these notes actually get sent,
   "send the email" cannot live inside the same transaction as the state change. Write the
   intent to an `outbox` table in that transaction, have a separate relay deliver it with
   a provider-side idempotency key. That is what closes the at-least-once window in §1 —
   for the send, which is the step where a duplicate actually costs something.
3. **Kill the `while(true)` poll.** `LISTEN/NOTIFY` on task insert plus a slow poll as a
   floor. The poll wakes up every second per worker forever, which is free at one worker
   and silly at fifty.
4. **Migrations.** `schema.sql` currently drops and recreates. Any real deploy needs
   ordered, irreversible-by-default migrations.
5. **TypeScript**, and a generated row type per table. The `jsonb` columns are `any` today
   and the Apollo response shape is load-bearing in three files.

**Operational**

6. **Rate limiting that knows about Apollo's actual budget.** Right now backoff is
   reactive — we find the limit by hitting it. Production wants a shared token bucket in
   Redis keyed per API key, so ten workers share one quota, plus a credit-spend counter,
   because on a paid Apollo plan every enrichment is money and a runaway loop is a bill.
7. **Observability.** Structured logs with `room_id`/`task_id` on every line, and three
   metrics that actually page someone: tasks in `failed`, oldest `awaiting_review`
   (is a human stuck?), and Apollo 429 rate.
8. **A dead-letter view, not a dead-end state.** `failed` tasks are currently invisible in
   the UI and nothing retries them. They need a human-triggered requeue.

**Product / correctness-of-behaviour**

9. **Auth, and `actor` that means something.** `?user=alice` is a URL parameter — anyone
   can be anyone. Every optimistic-lock guarantee in §2 is real, but it protects against
   *races*, not against *impersonation*. Real sessions, and `claimed_by` as a user ID.
10. **LinkedIn scraping is the part I'd push back on.** Logged-out scraping is
    unreliable by design and against LinkedIn's ToS; doing it at volume from server IPs
    gets the IP blocked and the account banned. For production I'd either use a vendor
    that carries that risk contractually (Proxycurl, Bright Data), or drop it — Apollo's
    own enrichment already returns a headline for most records, which is where the
    current draft copy actually comes from.
11. **The drafts need a human-in-the-loop quality signal.** Approve/edit/skip is already
    the training data: log the edit distance between draft and sent copy and you learn
    which ICPs the prompt is bad at. That is the interesting product, and the schema
    already records it.
12. **Per-room worker fairness.** One busy room currently starves the others, because the
    pickup query orders only by `next_run_at`. Ordering by `(room_id, next_run_at)` with a
    round-robin cursor, or a per-room concurrency cap, fixes it.
13. **The send step is where this gets hard, and it isn't an engineering problem.**
    Everything above is about not losing work. Once approved notes actually go out, the
    binding constraint becomes domain reputation: Google and Microsoft both enforce bulk
    sender auth (SPF/DKIM/DMARC) and complaint-rate thresholds, and a burned sending domain
    costs weeks, not a redeploy. That implies things the current schema does not model —
    per-domain daily send caps, mailbox rotation with warmup, a suppression list checked
    before send, and bounce/complaint webhooks feeding back into the room. Worth saying
    plainly: the reason this design blocks on a human before every send is not just
    workflow correctness, it is the thing that keeps reply rates up and domains alive.
    Full autonomy is the version that generates volume and burns the asset.

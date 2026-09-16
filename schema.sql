-- Room state machine. Everything durable lives here; the worker holds no memory.
drop table if exists events, task_steps, tasks, room_members, rooms cascade;

create table rooms (
  id          uuid primary key default gen_random_uuid(),
  objective   text not null,
  icp         text not null,
  status      text not null default 'running' check (status in ('running','paused')),
  -- set in the same tx as the task inserts: a crash mid-search leaves it null and the
  -- whole search retries; task inserts are ON CONFLICT DO NOTHING so the retry is safe.
  searched_at timestamptz,
  -- the search retries on the same durable backoff the tasks use
  next_search_at  timestamptz not null default now(),
  search_attempts int not null default 0,
  last_error      text,
  created_at  timestamptz not null default now()
);

-- The room's roster. The brief asks for a room with 2 human members and 1 agent, so
-- membership is a real thing you can be in or out of, not a string in a URL.
create table room_members (
  room_id  uuid not null references rooms(id) on delete cascade,
  name     text not null,
  kind     text not null check (kind in ('human','agent')),
  joined_at timestamptz not null default now(),
  primary key (room_id, name)
);

create table tasks (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null references rooms(id) on delete cascade,
  person_key       text not null,                      -- apollo person id
  person           jsonb not null default '{}',        -- search-result snapshot
  state            text not null default 'pending_enrich'
                   check (state in ('pending_enrich','enriched','awaiting_review','done','failed')),
  enrichment       jsonb,
  draft            text,
  decision         text check (decision in ('approved','edited','skipped')),
  linkedin_headline text,                              -- stretch: pulled by a real browser
  claimed_by       text,
  claim_expires_at timestamptz,                        -- lease: a human who walks away frees the task
  version          int  not null default 0,            -- optimistic lock for human actions
  attempts         int  not null default 0,
  next_run_at      timestamptz not null default now(), -- backoff lives here, not in a timer
  last_error       text,
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (room_id, person_key),                        -- a person enters a room once
  -- Ownership is enforced by the database, not by the API: a task cannot be claimed by
  -- someone who is not in this room. NULL claimed_by skips the check, which is what we want.
  foreign key (room_id, claimed_by) references room_members (room_id, name)
);

create index tasks_pickup on tasks (room_id, state, next_run_at);

-- The exactly-once ledger. A step that committed here never runs again;
-- the worker reads the cached output instead of re-calling Apollo.
create table task_steps (
  task_id    uuid not null references tasks(id) on delete cascade,
  step       text not null,
  output     jsonb,
  created_at timestamptz not null default now(),
  primary key (task_id, step)
);

-- Append-only audit of every action by every actor, human or agent.
create table events (
  id         bigserial primary key,
  room_id    uuid not null references rooms(id) on delete cascade,
  task_id    uuid references tasks(id) on delete cascade,
  actor      text not null,
  type       text not null,
  data       jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index events_room on events (room_id, id desc);

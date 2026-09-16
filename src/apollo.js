/**
 * Apollo client. Deliberately has NO retry loop of its own: it throws a typed error and
 * the worker persists the backoff in tasks.next_run_at. One retry mechanism, and it is
 * the one that survives the process being killed.
 */
import { readFileSync } from 'node:fs';

const BASE = process.env.APOLLO_BASE_URL ?? 'https://api.apollo.io/api/v1';

/**
 * Replay mode. Real Apollo responses recorded once into fixtures/apollo.json, so the whole
 * project runs end to end with no API key and no signup. On by default when no key is set,
 * because a reviewer should be able to see this work before deciding to go get credentials.
 */
const USE_FIXTURES = process.env.APOLLO_FIXTURES === '1' || !process.env.APOLLO_API_KEY;
let fixtures;
const loadFixtures = () => (fixtures ??= JSON.parse(readFileSync('fixtures/apollo.json', 'utf8')));

// Replaying at zero latency would be a lie: steps would commit faster than anything could
// observe or interrupt them, and a crash test could never catch the worker mid-run.
const FIXTURE_LATENCY_MS = Number(process.env.FIXTURE_LATENCY_MS ?? 150);
const replay = async (value) => {
  await new Promise((r) => setTimeout(r, FIXTURE_LATENCY_MS));
  return value;
};

if (USE_FIXTURES && !process.env.APOLLO_BASE_URL)
  console.log('[apollo] no APOLLO_API_KEY — replaying recorded fixtures (set one for live data)');

export class ApolloError extends Error {
  constructor(message, { status, retryAfterMs = 0, retryable = false }) {
    super(message);
    Object.assign(this, { status, retryAfterMs, retryable });
  }
}

async function call(path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': process.env.APOLLO_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // network blip / timeout: always worth another attempt
    throw new ApolloError(`network: ${e.message}`, { status: 0, retryable: true });
  }

  if (res.status === 429) {
    const header = Number(res.headers.get('retry-after'));
    throw new ApolloError('rate limited', {
      status: 429,
      retryAfterMs: Number.isFinite(header) && header > 0 ? header * 1000 : 0,
      retryable: true,
    });
  }
  if (res.status >= 500) {
    throw new ApolloError(`upstream ${res.status}`, { status: res.status, retryable: true });
  }
  if (!res.ok) {
    // 4xx other than 429 is our bug or a dead record: retrying will not fix it
    throw new ApolloError(`${res.status}: ${(await res.text()).slice(0, 300)}`, {
      status: res.status,
      retryable: false,
    });
  }
  return res.json();
}

/** ICP text -> up to `limit` people. `params` comes from the ICP parser. */
export async function searchPeople(params, limit = 10) {
  if (USE_FIXTURES && !process.env.APOLLO_BASE_URL)
    return replay(loadFixtures().search.slice(0, limit));
  const data = await call('/mixed_people/api_search', { ...params, per_page: limit, page: 1 });
  return (data.people ?? []).slice(0, limit);
}

/** Reveal the record behind a search hit (search returns obfuscated names on the free tier). */
export async function enrichPerson(apolloId) {
  if (USE_FIXTURES && !process.env.APOLLO_BASE_URL) {
    const person = loadFixtures().enrich[apolloId];
    if (!person) throw new ApolloError('not in fixtures', { status: 404, retryable: false });
    return replay(person);
  }
  const data = await call('/people/match?reveal_personal_emails=false', { id: apolloId });
  if (!data.person) throw new ApolloError('no match', { status: 404, retryable: false });
  return data.person;
}

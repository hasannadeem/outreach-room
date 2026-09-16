/**
 * Apollo client. Deliberately has NO retry loop of its own: it throws a typed error and
 * the worker persists the backoff in tasks.next_run_at. One retry mechanism, and it is
 * the one that survives the process being killed.
 */
import { readFileSync } from 'node:fs';
import type { ApolloPerson, ApolloSearchPerson, IcpParams } from './types.ts';

// `||`, not `??`: an APOLLO_BASE_URL that is set but empty (easy to do in a compose or CI
// env block) would otherwise become the base URL and every request would fail on a
// malformed address. Empty means "not configured".
const BASE = process.env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1';

/**
 * Replay mode. Real Apollo responses recorded once into fixtures/apollo.json, so the whole
 * project runs end to end with no API key and no signup. On by default when no key is set,
 * because a reviewer should be able to see this work before deciding to go get credentials.
 */
const USE_FIXTURES = process.env.APOLLO_FIXTURES === '1' || !process.env.APOLLO_API_KEY;
let fixtures: Fixtures | undefined;
const loadFixtures = (): Fixtures =>
  (fixtures ??= JSON.parse(readFileSync('fixtures/apollo.json', 'utf8')) as Fixtures);

// Replaying at zero latency would be a lie: steps would commit faster than anything could
// observe or interrupt them, and a crash test could never catch the worker mid-run.
const FIXTURE_LATENCY_MS = Number(process.env.FIXTURE_LATENCY_MS ?? 150);
const replay = async <T>(value: T): Promise<T> => {
  await new Promise((r) => setTimeout(r, FIXTURE_LATENCY_MS));
  return value;
};

/** True when search results come from the recorded fixtures rather than live Apollo. */
export const usingFixtures = (): boolean => USE_FIXTURES && !process.env.APOLLO_BASE_URL;

if (usingFixtures())
  console.log('[apollo] no APOLLO_API_KEY — replaying recorded fixtures (set one for live data)');

export class ApolloError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly retryable: boolean;

  constructor(message: string,
              { status, retryAfterMs = 0, retryable = false }:
              { status: number; retryAfterMs?: number; retryable?: boolean }) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

interface Fixtures {
  search: ApolloSearchPerson[];
  enrich: Record<string, ApolloPerson>;
}

function apiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (key) return key;
  // A local stub (APOLLO_BASE_URL) does not authenticate — the failure-injection tests
  // point at one. Only the real API needs a key, and reaching it without one is a
  // configuration bug rather than a runtime condition to paper over.
  if (process.env.APOLLO_BASE_URL) return 'stub-no-auth';
  throw new ApolloError('APOLLO_API_KEY is not set', { status: 0, retryable: false });
}

async function call(path: string, body: unknown): Promise<unknown> {
  // Resolved before the try: a missing key is a configuration error, and throwing it
  // inside the catch below would relabel it as a retryable network failure and burn five
  // attempts on something no amount of retrying can fix.
  const key = apiKey();

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // network blip / timeout: always worth another attempt
    throw new ApolloError(`network: ${(e as Error).message}`, { status: 0, retryable: true });
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
export async function searchPeople(params: IcpParams, limit = 10): Promise<ApolloSearchPerson[]> {
  if (USE_FIXTURES && !process.env.APOLLO_BASE_URL)
    return replay(loadFixtures().search.slice(0, limit));
  const data = await call('/mixed_people/api_search',
    { ...params, per_page: limit, page: 1 }) as { people?: ApolloSearchPerson[] };
  return (data.people ?? []).slice(0, limit);
}

/** Reveal the record behind a search hit (search returns obfuscated names on the free tier). */
export async function enrichPerson(apolloId: string): Promise<ApolloPerson> {
  if (USE_FIXTURES && !process.env.APOLLO_BASE_URL) {
    const person = loadFixtures().enrich[apolloId];
    if (!person) throw new ApolloError('not in fixtures', { status: 404, retryable: false });
    return replay(person);
  }
  const data = await call('/people/match?reveal_personal_emails=false',
    { id: apolloId }) as { person?: ApolloPerson };
  if (!data.person) throw new ApolloError('no match', { status: 404, retryable: false });
  return data.person;
}

/**
 * The agent's model calls, behind one interface.
 *
 * Providers are tried in this order, and `LLM_PROVIDER` overrides:
 *
 *   anthropic   ANTHROPIC_API_KEY (or an `ant auth login` profile)
 *   openrouter  OPENROUTER_API_KEY — free models available
 *   none        neither, so the caller uses its deterministic fallback
 *
 * The indirection earns its place because two providers are genuinely in use and their
 * request shapes differ: Anthropic constrains JSON with `output_config.format`, OpenRouter
 * with OpenAI-style `response_format`. Which one actually answered is returned as `via` and
 * written to the step ledger, so a draft is never silently credited to a model that never
 * ran.
 */
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_MODEL = 'claude-opus-5';

/**
 * Every free model on OpenRouter is a reasoning model, and without `reasoning.exclude`
 * they return the chain of thought in `content` — the "note" comes back as paragraphs of
 * the model counting its own words. Excluding it yields just the answer.
 *
 * Note that `exclude` only hides those tokens; the model still generates and bills them
 * against max_tokens. A 40-word note therefore needs a budget in the thousands, or the
 * reasoning consumes it all and the answer is truncated or empty.
 */
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL
  ?? 'nex-agi/nex-n2.5-pro:free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type Provider = 'anthropic' | 'openrouter' | 'none';

export interface CompleteInput {
  system: string;
  user: string;
  /** JSON schema constraining the reply. Both providers enforce it natively. */
  schema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface Completion { text: string; via: Provider }

export function provider(): Provider {
  const forced = process.env.LLM_PROVIDER as Provider | undefined;
  if (forced) return forced;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

async function viaAnthropic(
  { system, user, schema, maxTokens = 1024 }: CompleteInput): Promise<string> {
  const res = await new Anthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    output_config: {
      effort: 'low' as const,
      ...(schema ? { format: { type: 'json_schema' as const, schema } } : {}),
    },
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text).join('').trim();
}

async function viaOpenRouter(
  { system, user, schema, maxTokens = 1024 }: CompleteInput): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      reasoning: { exclude: true },
      ...(schema && {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', strict: true, schema },
        },
      }),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 90_000)),
  });

  const body = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; code?: number };
  };
  if (body.error) {
    const err = new Error(`openrouter ${body.error.code ?? ''}: ${body.error.message ?? ''}`.trim());
    // Free models are routinely overloaded or rate limited; that is worth another go.
    (err as Error & { transient?: boolean }).transient =
      body.error.code === 429 || Number(body.error.code) >= 500;
    throw err;
  }
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) {
    // Usually the reasoning consumed the whole budget. Worth another attempt.
    const err = new Error('openrouter returned no content') as Error & { transient?: boolean };
    err.transient = true;
    throw err;
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Throws when no provider is configured or the call ultimately fails; callers fall back.
 *
 * The short in-process retry here is a deliberate exception to the rule the Apollo client
 * follows (no retries of its own — the worker owns durable backoff). The difference is the
 * consequence of giving up: a failed Apollo call loses nothing because the task retries,
 * whereas a failed model call degrades that draft to a template permanently, since the step
 * commits either way. Free models return 429 often enough that one retry is the difference
 * between a model-written room and a half-templated one.
 */
export async function complete(input: CompleteInput, attempts = 3): Promise<Completion> {
  const via = provider();
  if (via === 'none') throw new Error('no LLM provider configured');

  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      const text = via === 'anthropic' ? await viaAnthropic(input) : await viaOpenRouter(input);
      return { text, via };
    } catch (e) {
      last = e;
      const transient = (e as { transient?: boolean }).transient ?? false;
      if (!transient || i === attempts) break;
      await sleep(600 * i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

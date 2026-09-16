/**
 * The agent's two thinking steps: turn a free-text ICP into Apollo search params,
 * and write the outreach note.
 *
 * Both degrade to a deterministic fallback if no Anthropic credential is configured or
 * the call fails, so the room still completes with only an Apollo key. Which path ran is
 * recorded in the step output (`via`) rather than hidden.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const client = new Anthropic();   // resolves ANTHROPIC_API_KEY or an `ant auth login` profile

const ICP_SCHEMA = {
  type: 'object',
  properties: {
    person_titles:    { type: 'array', items: { type: 'string' } },
    person_locations: { type: 'array', items: { type: 'string' } },
    q_organization_keyword_tags: { type: 'array', items: { type: 'string' } },
    organization_num_employees_ranges: {
      type: 'array',
      items: { type: 'string', description: 'e.g. "11,50" or "51,200"' },
    },
  },
  required: ['person_titles', 'person_locations',
             'q_organization_keyword_tags', 'organization_num_employees_ranges'],
  additionalProperties: false,
};

// No-LLM fallback. Apollo's q_keywords returns nothing for a full sentence, so match the
// ICP against common titles instead. ponytail: a fixed list, not an extractor — the LLM
// path above is the real one; this only keeps the room runnable with just an Apollo key.
const TITLES = [
  'Chief Technology Officer', 'Chief Executive Officer', 'Chief Revenue Officer',
  'VP of Engineering', 'VP of Sales', 'VP of Marketing', 'VP of Product', 'VP of Data',
  'Head of Engineering', 'Head of Product', 'Head of Growth', 'Head of Data', 'Head of Sales',
  'Director of Engineering', 'Director of Product', 'Engineering Manager', 'Product Manager',
  'Co-Founder', 'Founder', 'CTO', 'CEO', 'COO', 'CFO', 'CISO',
];
const LOCATIONS = {
  'united states': 'United States', ' us ': 'United States', 'usa': 'United States',
  'united kingdom': 'United Kingdom', ' uk ': 'United Kingdom', 'canada': 'Canada',
  'germany': 'Germany', 'india': 'India', 'australia': 'Australia', 'europe': 'Europe',
};

function heuristicIcp(icp) {
  const hay = ` ${icp.toLowerCase()} `;
  const person_titles = TITLES.filter((t) => hay.includes(t.toLowerCase()));
  const person_locations = [...new Set(
    Object.entries(LOCATIONS).filter(([k]) => hay.includes(k)).map(([, v]) => v))];
  if (person_titles.length) {
    return { ...(person_locations.length && { person_locations }), person_titles };
  }
  return { q_keywords: icp.split(/\s+/).slice(0, 3).join(' ') };
}

const text = (res) => res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/** Free-text ICP -> Apollo search params. */
export async function parseIcp(icp) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ICP_SCHEMA } },
      system:
        'Convert an ideal-customer-profile description into Apollo.io people-search filters. ' +
        'Use only filters the description actually supports; leave an array empty rather than inventing one.',
      messages: [{ role: 'user', content: icp }],
    });
    const parsed = JSON.parse(text(res));
    // drop empties so Apollo does not over-constrain the search
    const params = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v?.length));
    if (!Object.keys(params).length) throw new Error('no usable filters');
    return { params, via: 'llm' };
  } catch (e) {
    return { params: heuristicIcp(icp), via: `fallback (${e.message.slice(0, 80)})` };
  }
}

/** Enriched person -> a 2-line outreach note. */
export async function draftNote({ person, enrichment, objective }) {
  const facts = {
    name: enrichment.name ?? person.first_name,
    title: enrichment.title,
    company: enrichment.organization?.name ?? person.organization?.name,
    headline: enrichment.headline,
    current_roles: (enrichment.employment_history ?? [])
      .filter((j) => j.current).slice(0, 3).map((j) => `${j.title} @ ${j.organization_name}`),
  };
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      output_config: { effort: 'low' },
      system:
        'Write a cold outreach note: EXACTLY two lines, no greeting, no sign-off, no subject line. ' +
        'Line 1 references something specific and verifiable from their profile. ' +
        'Line 2 connects it to the objective and asks for a short call. ' +
        'Under 40 words total. Plain text. Never invent facts not present in the profile.',
      messages: [{
        role: 'user',
        content: `Objective: ${objective}\n\nProspect profile:\n${JSON.stringify(facts, null, 2)}`,
      }],
    });
    const note = text(res);
    if (!note) throw new Error('empty completion');
    return { note, via: 'llm' };
  } catch (e) {
    // Template fallback. Keeps to two lines and never repeats the title back at them.
    const first = (facts.name ?? '').split(' ')[0] || 'there';
    const topic = (facts.headline ?? '')
      .split(/[|·—]/)[0].trim().replace(/[.,;:]+$/, '');            // first clean clause only
    const fresh = topic && !facts.title?.toLowerCase().includes(topic.toLowerCase().slice(0, 12));
    return {
      note:
        `${first}, noticed you're ${facts.title ?? 'leading engineering'} at ${facts.company}` +
        `${fresh ? ` — ${topic.slice(0, 70)}` : ''}.\n` +
        `We're working on ${objective}. Worth a 15-minute call?`,
      via: `fallback (${e.message.slice(0, 80)})`,
    };
  }
}

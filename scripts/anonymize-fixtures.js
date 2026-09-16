/**
 * Scrubs the recorded Apollo fixtures.
 *
 * The fixtures were captured from live Apollo calls, so they arrived full of real people's
 * work emails, street addresses, photos and social profiles. None of those people agreed to
 * appear in this repository, so the committed fixture is synthetic: same shape, same field
 * types, same code path — invented identities.
 *
 *   node scripts/anonymize-fixtures.js fixtures/apollo.raw.json fixtures/apollo.json
 *
 * Structural fields (title, seniority, departments, industry, revenue bands) are kept,
 * because they are what the agent actually reasons over and none of them identify anyone.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , IN = 'fixtures/apollo.raw.json', OUT = 'fixtures/apollo.json'] = process.argv;

const PEOPLE = [
  ['Dana',    'Whitfield', 'Northwind Systems',    'northwindsystems.com'],
  ['Marcus',  'Oyelaran',  'Cadence Grid',         'cadencegrid.io'],
  ['Priya',   'Raghunath', 'Lumen Freight',        'lumenfreight.com'],
  ['Tomas',   'Berg',      'Halyard Analytics',    'halyard-analytics.com'],
  ['Renée',   'Castellan', 'Bright Meridian',      'brightmeridian.com'],
  ['Ibrahim', 'Sallah',    'Arbor Data Works',     'arbordataworks.com'],
  ['Wen',     'Zhao',      'Pillarstone Robotics', 'pillarstone.tech'],
  ['Aoife',   'Doherty',   'Kestrel Interactive',  'kestrelinteractive.com'],
  ['Samuel',  'Adeyemi',   'Fathom Logistics',     'fathomlogistics.co'],
  ['Elena',   'Vasquez',   'Tidewater Compute',    'tidewatercompute.com'],
];

const HEADLINES = [
  'Scaling platform teams without scaling headcount',
  'Engineering leadership · distributed systems · developer experience',
  'Building data infrastructure that product teams actually enjoy using',
  'Reliability, observability, and shipping on Fridays',
  'Former IC, still reads the diffs. Hiring thoughtfully.',
  'Platform engineering · Kubernetes · cost-aware architecture',
  'Turning research prototypes into systems that stay up',
  'Developer tooling, CI that finishes before your coffee does',
  'Logistics at scale — event-driven, boring on purpose',
  'Compute infrastructure · performance · pragmatic simplicity',
];

const CITIES = [
  ['Austin', 'Texas', '78701'], ['Denver', 'Colorado', '80202'],
  ['Portland', 'Oregon', '97204'], ['Raleigh', 'North Carolina', '27601'],
  ['Madison', 'Wisconsin', '53703'], ['Boise', 'Idaho', '83702'],
  ['Providence', 'Rhode Island', '02903'], ['Tacoma', 'Washington', '98402'],
  ['Omaha', 'Nebraska', '68102'], ['Burlington', 'Vermont', '05401'],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hexId = (n) => (n + 1).toString().padStart(24, 'a');   // stable, obviously synthetic

const raw = JSON.parse(readFileSync(IN, 'utf8'));
const realIds = raw.search.map((p) => p.id);

/** real apollo id -> the synthetic persona that replaces it */
const persona = new Map(realIds.map((id, i) => {
  const n = i % PEOPLE.length;
  const [first, last, company, domain] = PEOPLE[n];
  const [city, state, postal] = CITIES[n];
  return [id, {
    id: hexId(i), orgId: hexId(100 + i), first, last, company, domain, city, state, postal,
    headline: HEADLINES[n],
    email: `${first[0].toLowerCase()}${slug(last)}@${domain}`,
    linkedin: `http://www.linkedin.com/in/${slug(first + '-' + last)}`,
  }];
}));

/** Replace an organization block in place, keeping firmographics. */
function scrubOrg(org, p) {
  if (!org) return org;
  return {
    ...org,
    id: p.orgId,
    name: p.company,
    phone: null, primary_phone: null,
    city: p.city, state: p.state, postal_code: p.postal,
    raw_address: `${p.city}, ${p.state}`,
    street_address: null,
    logo_url: null, twitter_url: null, facebook_url: null, angellist_url: null,
    linkedin_uid: null,
    website_url: `https://${p.domain}`,
    linkedin_url: `http://www.linkedin.com/company/${slug(p.company)}`,
  };
}

const out = {
  recorded_at: raw.recorded_at,
  note: 'Synthetic fixtures. Real Apollo responses were captured to get the shape right, ' +
        'then every identifying field was replaced — see scripts/anonymize-fixtures.js. ' +
        'Nobody in this file is a real person.',
  search: raw.search.map((row) => {
    const p = persona.get(row.id);
    return {
      ...row,
      id: p.id,
      first_name: p.first,
      last_name_obfuscated: `${p.last[0]}***${p.last.slice(-1)}`,
      organization: scrubOrg(row.organization, p),
    };
  }),
  enrich: Object.fromEntries(Object.entries(raw.enrich).map(([realId, person]) => {
    const p = persona.get(realId);
    return [p.id, {
      ...person,
      id: p.id,
      name: `${p.first} ${p.last}`,
      first_name: p.first,
      last_name: p.last,
      email: p.email,
      headline: p.headline,
      city: p.city, state: p.state, postal_code: p.postal,
      street_address: null,
      formatted_address: `${p.city}, ${p.state}, United States`,
      photo_url: null, twitter_url: null, github_url: null, facebook_url: null,
      directory_url: null,
      linkedin_url: p.linkedin,
      organization_id: p.orgId,
      organization: scrubOrg(person.organization, p),
      employment_history: (person.employment_history ?? []).map((job, j) => ({
        ...job,
        organization_id: j === 0 ? p.orgId : hexId(200 + j),
        organization_name: j === 0 ? p.company : `${PEOPLE[(j * 3) % PEOPLE.length][2]}`,
        emails: null,
        raw_address: null,
      })),
    }];
  })),
};

writeFileSync(OUT, JSON.stringify(out, null, 1));

// Fail loudly if anything identifying survived the pass.
const text = JSON.stringify(out);
const leaks = [
  [/[\w.+-]+@(?!(?:northwindsystems|cadencegrid|lumenfreight|halyard-analytics|brightmeridian|arbordataworks|pillarstone|kestrelinteractive|fathomlogistics|tidewatercompute)\.)[\w.-]+\.\w{2,}/g, 'email'],
  [/media\.licdn\.com/g, 'linkedin photo'],
  [/"street_address":\s*"[^"]+"/g, 'street address'],
];
const found = leaks.flatMap(([re, label]) =>
  (text.match(re) ?? []).slice(0, 3).map((m) => `${label}: ${m}`));

console.log(`${OUT}: ${out.search.length} synthetic people`);
if (found.length) {
  console.error('LEAK — real data survived:\n  ' + found.join('\n  '));
  process.exit(1);
}
console.log('no real emails, photos or addresses remain');

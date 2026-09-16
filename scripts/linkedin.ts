/**
 * Stretch: open one prospect's LinkedIn in a real browser and pull their headline.
 *
 * Goes through the same task_steps ledger as every other step, so re-running never
 * re-opens a profile that already succeeded. Logged-out LinkedIn serves an auth wall to a
 * good share of traffic; that outcome is recorded as 'blocked' with a screenshot rather
 * than retried into a ban.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pool, q, tx, logEvent } from '../src/db.ts';

const { rows: [task] } = await q(`
  select t.* from tasks t
  left join task_steps s on s.task_id = t.id and s.step = 'linkedin'
  where t.enrichment->>'linkedin_url' is not null and s.task_id is null
  order by t.created_at limit 1`);

if (!task) {
  console.log('no prospect with an unvisited linkedin_url — run the worker first');
  await pool.end();
  process.exit(0);
}

const url = task.enrichment.linkedin_url.replace(/^http:/, 'https:');
console.log(`opening ${url}`);
mkdirSync('playwright-out', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});

let result;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000);   // the top card hydrates after DOMContentLoaded

  const scraped = await page.evaluate(() => {
    const clean = (t) => t?.replace(/\s+/g, ' ').trim() || null;

    // 1. the visible headline, when LinkedIn serves the full public layout
    const visible = clean(document.querySelector(
      '.top-card-layout__headline, [data-test-id="hero-title"], .text-body-medium'
    )?.textContent);

    // 2. behind the sign-in modal the headline is still served in the page metadata,
    //    as "<headline> · Experience: ... · Education: ...". Same page, same browser.
    const meta = (document.querySelector(
      'meta[property="og:description"], meta[name="description"]') as HTMLMetaElement | null)?.content;
    const fromMeta = clean(meta?.split(/\s·\s(?:Experience|Education|Location):/)[0]);

    return {
      name: clean(document.querySelector('h1')?.textContent),
      headline: visible || fromMeta,
      source: visible ? 'top-card' : fromMeta ? 'og:description' : null,
    };
  });

  result = scraped.headline
    ? { status: 'ok', ...scraped, url }
    : { status: 'blocked', reason: 'auth wall, no headline in page', url, final_url: page.url() };
} catch (e) {
  result = { status: 'error', reason: (e as Error).message.slice(0, 200), url };
}

const shot = `playwright-out/${task.person_key}.png`;
await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
result.screenshot = shot;
await browser.close();

await tx(async (c) => {
  await c.query(
    `insert into task_steps (task_id, step, output) values ($1,'linkedin',$2)
     on conflict do nothing`, [task.id, result]);
  if (result.status === 'ok')
    await c.query('update tasks set linkedin_headline = $2 where id = $1',
      [task.id, result.headline]);
  await logEvent(c, { roomId: task.room_id, taskId: task.id, actor: 'agent',
    type: 'linkedin_scraped', data: result });
});

console.log(result.status === 'ok'
  ? `headline: "${result.headline}"`
  : `${result.status}: ${result.reason} (screenshot: ${shot})`);
await pool.end();

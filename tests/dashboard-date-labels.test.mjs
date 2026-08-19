import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const valuesSource = html.slice(
  html.indexOf('function values('),
  html.indexOf('\nfunction drawTrend', html.indexOf('function values(')),
);
const evaluated = Function(`${valuesSource}; return { values, withCurrentTrendPoint };`)();
const { values, withCurrentTrendPoint } = evaluated;

test('labels stale ETF snapshots with their actual valuation date', () => {
  assert.match(html, /id="todayLabel"/);
  assert.match(html, /id="dayChangeHeader"/);
  assert.match(html, /date\?`\$\{date\} 涨跌`/);
  assert.match(html, /ETF \$\{h\.quoteDate\|\|''\}/);
});

test('does not mix a stale fund daily move into a different ETF valuation date', () => {
  assert.match(html, /changeDate=h\.market==='fund'\?h\.navDate:h\.quoteDate/);
  assert.match(html, /aligned=changeDate===date/);
  assert.match(html, /today:aligned&&h\.pre/);
  const staleFund = values({
    market: 'fund', amount: 6850, units: 100, entry: 1.3263,
    price: 1.3322, pre: 1.3312, navDate: '2026-08-17', fee: 0,
  }, '2026-08-18');
  const currentEtf = values({
    market: 'sh', amount: 2800, entry: 1.176,
    price: 1.161, pre: 1.156, quoteDate: '2026-08-18',
  }, '2026-08-18');
  assert.equal(staleFund.today, 0);
  assert.equal(staleFund.dayPct, null);
  assert.ok(Math.abs(currentEtf.today - 14) < 1e-9);
});

test('can refresh final quotes for thirty minutes after the close', () => {
  assert.match(html, /t\.minutes>=570&&t\.minutes<=930/);
});

test('appends and continuously replaces the current realtime trend point', () => {
  const confirmed = [{ date: '2026-08-18', nav: 1.0302 }];
  const intraday = withCurrentTrendPoint(confirmed, '2026-08-19', 1.0235, true);
  assert.deepEqual(intraday, [
    { date: '2026-08-18', nav: 1.0302 },
    { date: '2026-08-19', nav: 1.0235, live: true, latest: true },
  ]);
  const refreshed = withCurrentTrendPoint(intraday, '2026-08-19', 1.0241, true);
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed.at(-1).nav, 1.0241);
  assert.equal(refreshed.at(-1).live, true);
  assert.match(html, /liveQuoteDate=quotes\[0\]\.date/);
  assert.match(html, /history=withCurrentTrendPoint\(HISTORY_FALLBACK,date,cost\?value\/cost:NaN,live\)/);
});

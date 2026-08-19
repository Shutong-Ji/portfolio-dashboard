import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const valuesSource = html.slice(
  html.indexOf('function values('),
  html.indexOf('\nfunction drawTrend', html.indexOf('function values(')),
);
const values = Function(`${valuesSource}; return values;`)();

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

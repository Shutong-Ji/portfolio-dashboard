import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updatePortfolio } from '../scripts/update-portfolio.mjs';

const codes = ['512890', '159915', '513500', '513100', '511130', '159985', '159980', '159981', '518880'];
const entry = [1.176, 3.355, 2.484, 2.068, 107.272, 2.121, 2.094, 1.459, 8.4];
const price = [1.157, 3.604, 2.711, 2.226, 108.83, 2.126, 2.141, 1.502, 9.042];

function baseHtml(date = '2026-08-13') {
  const market = Object.fromEntries(codes.map((code, index) => [code, {
    entry: entry[index], price: price[index], pre: price[index], date,
  }]));
  return `const MARKET_FALLBACK=${JSON.stringify(market)};\n` +
    `const HISTORY_FALLBACK=${JSON.stringify([{ date, nav: 1.02 }])};\n` +
    'const FUND_FALLBACK={"009803":{"entry":1.3263,"nav":1.3305,"pre":1.3305,"date":"2026-08-12"}};\n';
}

const response = body => ({ ok: true, status: 200, json: async () => body });
const textResponse = body => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});
const timestamp = iso => Math.floor(new Date(iso).getTime() / 1000);

function successfulFetch(quoteDate = '2026-08-17') {
  return async url => {
    if (String(url).includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code,
        f2: price[index] + 0.01,
        f18: price[index],
        f124: timestamp(`${quoteDate}T07:00:00Z`),
      })) } });
    }
    return response({ Data: { LSJZList: [
      { FSRQ: '2026-08-14', DWJZ: '1.3310' },
      { FSRQ: '2026-08-13', DWJZ: '1.3308' },
    ] } });
  };
}

async function fixture(html = baseHtml()) {
  const directory = await mkdtemp(join(tmpdir(), 'portfolio-updater-'));
  const indexPath = join(directory, 'index.html');
  await writeFile(indexPath, html, 'utf8');
  return indexPath;
}

function constant(html, name) {
  return JSON.parse(html.match(new RegExp(`const ${name}=(.*?);`))[1]);
}

const quiet = { log() {}, warn() {} };

test('appends one complete trading-day snapshot and keeps the fixed fund entry NAV', async () => {
  const indexPath = await fixture();
  const result = await updatePortfolio({
    indexPath,
    fetchFn: successfulFetch(),
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const html = await readFile(indexPath, 'utf8');
  const market = constant(html, 'MARKET_FALLBACK');
  const history = constant(html, 'HISTORY_FALLBACK');
  const fund = constant(html, 'FUND_FALLBACK')['009803'];
  assert.equal(result.changed, true);
  assert.equal(Object.keys(market).length, 9);
  assert.deepEqual([...new Set(Object.values(market).map(item => item.date))], ['2026-08-17']);
  assert.deepEqual(history.map(point => point.date), ['2026-08-13', '2026-08-17']);
  assert.equal(fund.entry, 1.3263);
  assert.equal(fund.nav, 1.331);
  assert.equal(fund.date, '2026-08-14');
});

test('does not append a duplicate or weekend date', async () => {
  const indexPath = await fixture(baseHtml('2026-08-14'));
  const result = await updatePortfolio({
    indexPath,
    fetchFn: successfulFetch('2026-08-14'),
    now: new Date('2026-08-16T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const history = constant(await readFile(indexPath, 'utf8'), 'HISTORY_FALLBACK');
  assert.equal(result.date, '2026-08-14');
  assert.equal(history.length, 1);
});

test('uses one complete Tencent snapshot when Eastmoney ETF quotes fail', async () => {
  const indexPath = await fixture();
  const fetchFn = async url => {
    if (String(url).includes('ulist.np')) throw new Error('Eastmoney reset');
    if (String(url).includes('qt.gtimg.cn')) {
      return textResponse(codes.map((code, index) =>
        `v_${index === 1 || index >= 5 && index <= 7 ? 'sz' : 'sh'}${code}="1~ETF~${code}~${price[index] + 0.01}~${price[index]}~0~20260817000000";`,
      ).join('\n'));
    }
    return response({ Data: { LSJZList: [{ FSRQ: '2026-08-14', DWJZ: '1.3310' }] } });
  };
  const result = await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const market = constant(await readFile(indexPath, 'utf8'), 'MARKET_FALLBACK');
  assert.equal(result.changed, true);
  assert.deepEqual([...new Set(Object.values(market).map(item => item.date))], ['2026-08-17']);
});

test('keeps the existing file and exits successfully when both data sources fail', async () => {
  const indexPath = await fixture();
  const before = await readFile(indexPath, 'utf8');
  const result = await updatePortfolio({
    indexPath,
    fetchFn: async () => { throw new Error('socket hang up'); },
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  assert.equal(result.changed, false);
  assert.equal(await readFile(indexPath, 'utf8'), before);
});

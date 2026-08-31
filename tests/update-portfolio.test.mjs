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
  text: async () => body,
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

test('backfills a missed trading day from the common ETF calendar', async () => {
  const indexPath = await fixture(baseHtml('2026-08-13'));
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code,
        f2: price[index] + 0.02,
        f18: price[index] + 0.01,
        f124: timestamp('2026-08-17T07:00:00Z'),
      })) } });
    }
    if (value.includes('fqkline')) {
      const symbol = new URL(value).searchParams.get('param').split(',')[0];
      const index = codes.indexOf(symbol.slice(2));
      return response({ data: { [symbol]: { day: [
        ['2026-07-28', '0', String(entry[index])],
        ['2026-08-13', '0', String(price[index])],
        ['2026-08-14', '0', String(price[index] + 0.005)],
        ['2026-08-17', '0', String(price[index] + 0.02)],
      ] } } });
    }
    return response({ Data: { LSJZList: [
      { FSRQ: '2026-08-14', DWJZ: '1.3310' },
      { FSRQ: '2026-08-13', DWJZ: '1.3308' },
      { FSRQ: '2026-07-28', DWJZ: '1.3263' },
    ] } });
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const history = constant(await readFile(indexPath, 'utf8'), 'HISTORY_FALLBACK');
  assert.deepEqual(history.map(point => point.date), [
    '2026-07-28', '2026-08-13', '2026-08-14', '2026-08-17',
  ]);
  assert.equal(history[0].nav, 1);
  assert.ok(history.every(point => !['2026-08-15', '2026-08-16'].includes(point.date)));
});

test('paginates the fund API when the server caps each page at twenty rows', async () => {
  const indexPath = await fixture(baseHtml('2026-08-26'));
  const requestedPages = [];
  const pageOneDates = [
    '2026-08-31', '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25',
    '2026-08-24', '2026-08-21', '2026-08-20', '2026-08-19', '2026-08-18',
    '2026-08-17', '2026-08-14', '2026-08-13', '2026-08-12', '2026-08-11',
    '2026-08-10', '2026-08-07', '2026-08-06', '2026-08-05', '2026-08-04',
  ];
  const pageTwoDates = ['2026-08-03', '2026-07-31', '2026-07-30', '2026-07-29', '2026-07-28'];
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code,
        f2: price[index] + 0.01,
        f18: price[index],
        f124: timestamp('2026-08-31T07:00:00Z'),
      })) } });
    }
    if (value.includes('fqkline')) {
      const symbol = new URL(value).searchParams.get('param').split(',')[0];
      const index = codes.indexOf(symbol.slice(2));
      return response({ data: { [symbol]: { day: [
        ['2026-07-28', '0', String(entry[index])],
        ['2026-07-29', '0', String(entry[index] + 0.001)],
        ['2026-08-26', '0', String(price[index])],
        ['2026-08-27', '0', String(price[index] + 0.002)],
        ['2026-08-28', '0', String(price[index] + 0.004)],
        ['2026-08-31', '0', String(price[index] + 0.01)],
      ] } } });
    }
    if (value.includes('lsjz')) {
      const page = Number(new URL(value).searchParams.get('pageIndex'));
      requestedPages.push(page);
      const dates = page === 1 ? pageOneDates : page === 2 ? pageTwoDates : [];
      return response({ TotalCount: 25, Data: { LSJZList: dates.map((date, index) => ({
        FSRQ: date,
        DWJZ: String(1.331 - index * 0.0001),
      })) } });
    }
    throw new Error('unexpected URL');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-09-01T00:30:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const html = await readFile(indexPath, 'utf8');
  const history = constant(html, 'HISTORY_FALLBACK');
  const fund = constant(html, 'FUND_FALLBACK')['009803'];
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(history[0].date, '2026-07-28');
  assert.equal(history[0].nav, 1);
  assert.ok(history.some(point => point.date === '2026-07-29'));
  assert.equal(history.at(-1).date, '2026-08-31');
  assert.equal(fund.date, '2026-08-31');
});

test('rejects an incomplete fund page sequence and uses the chart fallback', async () => {
  const indexPath = await fixture(baseHtml('2026-08-26'));
  const requestedPages = [];
  const pageOneDates = [
    '2026-08-31', '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25',
    '2026-08-24', '2026-08-21', '2026-08-20', '2026-08-19', '2026-08-18',
    '2026-08-17', '2026-08-14', '2026-08-13', '2026-08-12', '2026-08-11',
    '2026-08-10', '2026-08-07', '2026-08-06', '2026-08-05', '2026-08-04',
  ];
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code,
        f2: price[index] + 0.01,
        f18: price[index],
        f124: timestamp('2026-08-31T07:00:00Z'),
      })) } });
    }
    if (value.includes('/f10/lsjz')) {
      const page = Number(new URL(value).searchParams.get('pageIndex'));
      requestedPages.push(page);
      const dates = page === 1 ? pageOneDates : [];
      return response({ TotalCount: 25, Data: { LSJZList: dates.map((date, index) => ({
        FSRQ: date,
        DWJZ: String(1.331 - index * 0.0001),
      })) } });
    }
    if (value.includes('pingzhongdata')) {
      const points = [
        { x: new Date('2026-07-28T12:00:00+08:00').getTime(), y: 1.3263 },
        { x: new Date('2026-08-31T12:00:00+08:00').getTime(), y: 1.331 },
      ];
      return textResponse(`var Data_netWorthTrend = ${JSON.stringify(points)};`);
    }
    throw new Error('historical source unavailable');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-09-01T00:30:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const fund = constant(await readFile(indexPath, 'utf8'), 'FUND_FALLBACK')['009803'];
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(fund.entry, 1.3263);
  assert.equal(fund.nav, 1.331);
  assert.equal(fund.date, '2026-08-31');
});

test('uses the chart NAV endpoint when the paginated fund endpoint fails', async () => {
  const indexPath = await fixture();
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code, f2: price[index] + 0.01, f18: price[index],
        f124: timestamp('2026-08-17T07:00:00Z'),
      })) } });
    }
    if (value.includes('/f10/lsjz')) throw new Error('primary fund endpoint unavailable');
    if (value.includes('pingzhongdata')) {
      const points = [
        { x: new Date('2026-07-28T12:00:00+08:00').getTime(), y: 1.3263 },
        { x: new Date('2026-08-14T12:00:00+08:00').getTime(), y: 1.331 },
      ];
      return textResponse(`var Data_netWorthTrend = ${JSON.stringify(points)};`);
    }
    throw new Error('historical source unavailable');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const fund = constant(await readFile(indexPath, 'utf8'), 'FUND_FALLBACK')['009803'];
  assert.equal(fund.entry, 1.3263);
  assert.equal(fund.nav, 1.331);
  assert.equal(fund.date, '2026-08-14');
});

test('uses Eastmoney history and the last fund NAV when other sources fail', async () => {
  const indexPath = await fixture();
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np') || value.includes('qt.gtimg.cn') || value.includes('fqkline')) {
      throw new Error('realtime and Tencent history unavailable');
    }
    if (value.includes('push2his')) {
      const code = new URL(value).searchParams.get('secid').split('.')[1];
      const index = codes.indexOf(code);
      return response({ data: { klines: [
        `2026-07-28,0,${entry[index]}`,
        `2026-08-13,0,${price[index]}`,
        `2026-08-17,0,${price[index] + 0.01}`,
      ] } });
    }
    throw new Error('unexpected URL');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const html = await readFile(indexPath, 'utf8');
  const market = constant(html, 'MARKET_FALLBACK');
  const history = constant(html, 'HISTORY_FALLBACK');
  const fund = constant(html, 'FUND_FALLBACK')['009803'];
  assert.deepEqual([...new Set(Object.values(market).map(item => item.date))], ['2026-08-17']);
  assert.equal(history.at(-1).date, '2026-08-17');
  assert.equal(fund.date, '2026-08-12');
});

test('does not let lagging history overwrite a newer complete snapshot', async () => {
  const indexPath = await fixture();
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code, f2: price[index] + 0.01, f18: price[index],
        f124: timestamp('2026-08-17T07:00:00Z'),
      })) } });
    }
    if (value.includes('fqkline')) {
      const symbol = new URL(value).searchParams.get('param').split(',')[0];
      const index = codes.indexOf(symbol.slice(2));
      return response({ data: { [symbol]: { day: [
        ['2026-07-28', '0', String(entry[index])],
        ['2026-08-13', '0', String(price[index])],
        ['2026-08-14', '0', String(price[index] + 0.005)],
      ] } } });
    }
    if (value.includes('lsjz')) {
      return response({ Data: { LSJZList: [
        { FSRQ: '2026-08-14', DWJZ: '1.3310' },
        { FSRQ: '2026-07-28', DWJZ: '1.3263' },
      ] } });
    }
    throw new Error('unexpected URL');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const html = await readFile(indexPath, 'utf8');
  const market = constant(html, 'MARKET_FALLBACK');
  const history = constant(html, 'HISTORY_FALLBACK');
  assert.deepEqual([...new Set(Object.values(market).map(item => item.date))], ['2026-08-17']);
  assert.equal(history.at(-1).date, '2026-08-17');
});

test('merges a rolling historical window without truncating older confirmed points', async () => {
  const oldHistory = [
    { date: '2026-07-28', nav: 1 },
    { date: '2026-08-13', nav: 1.02 },
  ];
  const html = baseHtml('2026-08-13').replace(
    /const HISTORY_FALLBACK=.*?;/,
    `const HISTORY_FALLBACK=${JSON.stringify(oldHistory)};`,
  );
  const indexPath = await fixture(html);
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code, f2: price[index] + 0.01, f18: price[index],
        f124: timestamp('2026-08-17T07:00:00Z'),
      })) } });
    }
    if (value.includes('fqkline')) {
      const symbol = new URL(value).searchParams.get('param').split(',')[0];
      const index = codes.indexOf(symbol.slice(2));
      return response({ data: { [symbol]: { day: [
        ['2026-08-14', '0', String(price[index] + 0.005)],
        ['2026-08-17', '0', String(price[index] + 0.01)],
      ] } } });
    }
    if (value.includes('lsjz')) {
      return response({ Data: { LSJZList: [
        { FSRQ: '2026-08-14', DWJZ: '1.3310' },
        { FSRQ: '2026-07-28', DWJZ: '1.3263' },
      ] } });
    }
    throw new Error('unexpected URL');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const history = constant(await readFile(indexPath, 'utf8'), 'HISTORY_FALLBACK');
  assert.deepEqual(history.slice(0, 2), oldHistory);
  assert.equal(history.at(-1).date, '2026-08-17');
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

test('still updates ETFs when both fund NAV endpoints are temporarily unavailable', async () => {
  const indexPath = await fixture();
  const fetchFn = async url => {
    const value = String(url);
    if (value.includes('ulist.np')) {
      return response({ data: { diff: codes.map((code, index) => ({
        f12: code, f2: price[index] + 0.01, f18: price[index],
        f124: timestamp('2026-08-17T07:00:00Z'),
      })) } });
    }
    throw new Error('secondary source unavailable');
  };
  await updatePortfolio({
    indexPath,
    fetchFn,
    now: new Date('2026-08-17T09:00:00Z'),
    sleep: async () => {},
    logger: quiet,
  });
  const html = await readFile(indexPath, 'utf8');
  const market = constant(html, 'MARKET_FALLBACK');
  const fund = constant(html, 'FUND_FALLBACK')['009803'];
  const history = constant(html, 'HISTORY_FALLBACK');
  assert.deepEqual([...new Set(Object.values(market).map(item => item.date))], ['2026-08-17']);
  assert.equal(fund.date, '2026-08-12');
  assert.equal(fund.nav, 1.3305);
  assert.equal(history.at(-1).date, '2026-08-17');
});

test('keeps the existing file but fails loudly when every ETF source fails', async () => {
  const indexPath = await fixture();
  const before = await readFile(indexPath, 'utf8');
  await assert.rejects(
    updatePortfolio({
      indexPath,
      fetchFn: async () => { throw new Error('socket hang up'); },
      now: new Date('2026-08-17T09:00:00Z'),
      sleep: async () => {},
      logger: quiet,
    }),
    /No usable ETF source/,
  );
  assert.equal(await readFile(indexPath, 'utf8'), before);
});

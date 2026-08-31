import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultIndexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const fundCode = '009803';
const fundAmount = 6850;
const fundEntryNav = 1.3263;
const entryDate = '2026-07-28';
const etfs = [
  ['512890', 2800, '1'], ['159915', 2800, '0'], ['513500', 1400, '1'],
  ['513100', 1100, '1'], ['511130', 600, '1'], ['159985', 1100, '0'],
  ['159980', 2000, '0'], ['159981', 1600, '0'], ['518880', 200, '1'],
].map(([code, units, market]) => ({ code, units, market }));

const shanghaiDate = date => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
}).format(date);

function shanghaiMinutes(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type)?.value);
  return value('hour') * 60 + value('minute');
}

function confirmedThrough(now) {
  return shanghaiMinutes(now) >= 15 * 60
    ? shanghaiDate(now)
    : shanghaiDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

function readConstant(html, name) {
  const match = html.match(new RegExp(`const ${name}=(.*?);`));
  if (!match) throw new Error(`Missing ${name} in index.html`);
  return JSON.parse(match[1]);
}

function replaceConstant(html, name, value) {
  return html.replace(
    new RegExp(`const ${name}=.*?;`),
    `const ${name}=${JSON.stringify(value)};`,
  );
}

async function fetchJson(url, { fetchFn, headers = {}, sleep, attempts = 4 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent': 'Mozilla/5.0 portfolio-dashboard-updater/2.0',
          ...headers,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

async function fetchText(url, { fetchFn, headers = {}, sleep, attempts = 4 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: {
          Accept: 'text/plain,*/*',
          'User-Agent': 'Mozilla/5.0 portfolio-dashboard-updater/3.0',
          ...headers,
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

function validateSnapshots(snapshots) {
  if (snapshots.length !== etfs.length) {
    throw new Error(`Incomplete ETF snapshot: expected ${etfs.length}, received ${snapshots.length}`);
  }
  const dates = new Set(snapshots.map(item => item.date));
  if (dates.size !== 1) throw new Error('Mixed-date ETF snapshot');
  return snapshots;
}

async function eastmoneyEtfSnapshot({ fetchFn, sleep }) {
  const secids = etfs.map(item => `${item.market}.${item.code}`).join(',');
  const url = new URL('https://push2.eastmoney.com/api/qt/ulist.np/get');
  url.search = new URLSearchParams({
    secids, fields: 'f2,f12,f18,f124', fltt: '2',
  });
  const payload = await fetchJson(url, { fetchFn, sleep });
  const rows = payload?.data?.diff;
  if (!Array.isArray(rows) || rows.length !== etfs.length) {
    throw new Error(`Incomplete ETF snapshot: expected ${etfs.length}, received ${rows?.length ?? 0}`);
  }

  const byCode = new Map(rows.map(row => [String(row.f12), row]));
  const snapshots = etfs.map(item => {
    const row = byCode.get(item.code);
    const price = Number(row?.f2);
    const pre = Number(row?.f18);
    const timestamp = Number(row?.f124);
    if (!row || !Number.isFinite(price) || price <= 0 ||
        !Number.isFinite(pre) || pre <= 0 ||
        !Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(`Invalid ETF snapshot for ${item.code}`);
    }
    return {
      code: item.code,
      price,
      pre,
      date: shanghaiDate(new Date(timestamp * 1000)),
    };
  });
  return validateSnapshots(snapshots);
}

async function tencentEtfSnapshot({ fetchFn, sleep }) {
  const symbols = etfs.map(item => `${item.market === '1' ? 'sh' : 'sz'}${item.code}`).join(',');
  const url = `https://qt.gtimg.cn/q=${symbols}`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: {
          Accept: 'text/plain,*/*',
          Referer: 'https://gu.qq.com/',
          'User-Agent': 'Mozilla/5.0 portfolio-dashboard-updater/2.0',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      const body = new TextDecoder('gb18030').decode(await response.arrayBuffer());
      const rows = new Map();
      for (const match of body.matchAll(/v_(?:sh|sz)(\d+)="([^"]*)";/g)) {
        rows.set(match[1], match[2].split('~'));
      }
      const snapshots = etfs.map(item => {
        const fields = rows.get(item.code);
        const price = Number(fields?.[3]);
        const pre = Number(fields?.[4]);
        const quoteTime = fields?.find(value => /^\d{14}$/.test(value));
        if (!fields || !Number.isFinite(price) || price <= 0 ||
            !Number.isFinite(pre) || pre <= 0 || !quoteTime) {
          throw new Error(`Invalid Tencent ETF snapshot for ${item.code}`);
        }
        return {
          code: item.code,
          price,
          pre,
          date: `${quoteTime.slice(0, 4)}-${quoteTime.slice(4, 6)}-${quoteTime.slice(6, 8)}`,
        };
      });
      return validateSnapshots(snapshots);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

async function latestEtfSnapshot(options) {
  try {
    return await eastmoneyEtfSnapshot(options);
  } catch (eastmoneyError) {
    try {
      return await tencentEtfSnapshot(options);
    } catch (tencentError) {
      throw new AggregateError(
        [eastmoneyError, tencentError],
        'Both ETF quote sources are unavailable',
      );
    }
  }
}

function normalizeFundRows(rows) {
  return [...new Map(rows
    .map(row => ({ date: row.FSRQ, nav: Number(row.DWJZ) }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.nav) && row.nav > 0)
    .map(row => [row.date, row])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function paginatedFundRows({ fetchFn, sleep, now }) {
  const pageSize = 20;
  const rows = [];
  const seenDates = new Set();
  let expectedTotal = null;
  for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
    const url = new URL('https://api.fund.eastmoney.com/f10/lsjz');
    url.search = new URLSearchParams({
      fundCode, pageIndex: String(pageIndex), pageSize: String(pageSize),
      startDate: entryDate, endDate: shanghaiDate(now),
    });
    const payload = await fetchJson(url, {
      fetchFn,
      sleep,
      headers: { Referer: 'https://fundf10.eastmoney.com/' },
    });
    const pageRows = payload?.Data?.LSJZList;
    if (!Array.isArray(pageRows)) throw new Error(`Invalid fund NAV page ${pageIndex}`);
    const totalCount = Number(payload?.TotalCount);
    if (Number.isInteger(totalCount) && totalCount >= 0) {
      expectedTotal = expectedTotal === null ? totalCount : Math.max(expectedTotal, totalCount);
    }
    rows.push(...pageRows);
    const previousSize = seenDates.size;
    pageRows.forEach(row => seenDates.add(row?.FSRQ));
    if (expectedTotal !== null && seenDates.size >= expectedTotal) break;
    if (!pageRows.length || pageRows.length < pageSize) break;
    if (seenDates.size === previousSize) throw new Error(`Fund NAV pagination stalled at page ${pageIndex}`);
    if (pageIndex === 100) throw new Error('Fund NAV pagination exceeded safety limit');
  }
  if (expectedTotal !== null && seenDates.size < expectedTotal) {
    throw new Error(`Incomplete fund NAV pagination: expected ${expectedTotal}, received ${seenDates.size}`);
  }
  if (!normalizeFundRows(rows).length) throw new Error(`No valid NAV history for ${fundCode}`);
  const normalized = normalizeFundRows([
    ...rows,
    { FSRQ: entryDate, DWJZ: fundEntryNav },
  ]);
  return normalized;
}

async function chartFundRows({ fetchFn, sleep, now }) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${fundCode}.js?v=${now.getTime()}`;
  const body = await fetchText(url, {
    fetchFn,
    sleep,
    headers: { Referer: `https://fund.eastmoney.com/${fundCode}.html` },
  });
  const match = body.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`Missing backup NAV history for ${fundCode}`);
  const rows = JSON.parse(match[1]).map(row => ({
    FSRQ: shanghaiDate(new Date(Number(row.x))),
    DWJZ: row.y,
  })).filter(row => row.FSRQ >= entryDate && row.FSRQ <= shanghaiDate(now));
  if (!normalizeFundRows(rows).length) throw new Error(`No valid backup NAV history for ${fundCode}`);
  const normalized = normalizeFundRows([
    ...rows,
    { FSRQ: entryDate, DWJZ: fundEntryNav },
  ]);
  return normalized;
}

async function latestFundRows(options) {
  try {
    return await paginatedFundRows(options);
  } catch (primaryError) {
    try {
      return await chartFundRows(options);
    } catch (backupError) {
      throw new AggregateError([primaryError, backupError], 'Both fund NAV sources are unavailable');
    }
  }
}

async function tencentHistoricalCloses({ fetchFn, sleep, endDate }) {
  const histories = await Promise.all(etfs.map(async item => {
    const symbol = `${item.market === '1' ? 'sh' : 'sz'}${item.code}`;
    const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
    url.search = new URLSearchParams({
      param: `${symbol},day,${entryDate},${endDate},200,none`,
    });
    const payload = await fetchJson(url, {
      fetchFn,
      sleep,
      headers: { Referer: 'https://gu.qq.com/' },
    });
    const rows = payload?.data?.[symbol]?.day;
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(`No Tencent history for ${item.code}`);
    }
    const closes = new Map(rows
      .map(row => [row?.[0], Number(row?.[2])])
      .filter(([date, close]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0));
    if (!closes.size) throw new Error(`Invalid Tencent history for ${item.code}`);
    return [item.code, closes];
  }));
  return new Map(histories);
}

async function eastmoneyHistoricalCloses({ fetchFn, sleep, endDate }) {
  const begin = entryDate.replaceAll('-', '');
  const end = endDate.replaceAll('-', '');
  const histories = await Promise.all(etfs.map(async item => {
    const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
    url.search = new URLSearchParams({
      secid: `${item.market}.${item.code}`, klt: '101', fqt: '0',
      beg: begin, end, lmt: '200', fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53',
    });
    const payload = await fetchJson(url, { fetchFn, sleep });
    const rows = payload?.data?.klines;
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(`No Eastmoney history for ${item.code}`);
    }
    const closes = new Map(rows
      .map(row => String(row).split(','))
      .map(fields => [fields[0], Number(fields[2])])
      .filter(([date, close]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0));
    if (!closes.size) throw new Error(`Invalid Eastmoney history for ${item.code}`);
    return [item.code, closes];
  }));
  return new Map(histories);
}

async function latestHistoricalCloses(options) {
  try {
    return await tencentHistoricalCloses(options);
  } catch (tencentError) {
    try {
      return await eastmoneyHistoricalCloses(options);
    } catch (eastmoneyError) {
      throw new AggregateError(
        [tencentError, eastmoneyError],
        'Both ETF historical sources are unavailable',
      );
    }
  }
}

function fundNavOn(rows, date, fallback) {
  if (date === entryDate) return fundEntryNav;
  const row = rows.filter(item => item.date <= date).at(-1);
  if (row) return row.nav;
  if (fallback.date <= date) return fallback.nav;
  if (date > entryDate) return fundEntryNav;
  throw new Error(`No ${fundCode} NAV on or before ${date}`);
}

function portfolioCost(market) {
  return etfs.reduce((sum, item) => {
    const entry = Number(market[item.code]?.entry);
    if (!Number.isFinite(entry) || entry <= 0) throw new Error(`Missing entry price for ${item.code}`);
    return sum + entry * item.units + Math.max(entry * item.units * 0.0001, 5);
  }, fundAmount);
}

function portfolioNav(market, fundNav, cost) {
  const value = etfs.reduce((sum, item) => {
    const price = Number(market[item.code]?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Missing price for ${item.code}`);
    return sum + price * item.units;
  }, fundNav * (fundAmount / fundEntryNav));
  return value / cost;
}

export async function updatePortfolio({
  indexPath = defaultIndexPath,
  fetchFn = fetch,
  now = new Date(),
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  logger = console,
} = {}) {
  const before = await readFile(indexPath, 'utf8');
  const oldMarket = readConstant(before, 'MARKET_FALLBACK');
  const oldHistory = readConstant(before, 'HISTORY_FALLBACK');
  const oldFund = readConstant(before, 'FUND_FALLBACK')[fundCode];
  if (!oldHistory.length || !oldFund) throw new Error('Missing existing portfolio snapshot');

  const throughDate = confirmedThrough(now);
  const [etfResult, fundResult, historyResult] = await Promise.allSettled([
    latestEtfSnapshot({ fetchFn, sleep }),
    latestFundRows({ fetchFn, sleep, now }),
    latestHistoricalCloses({ fetchFn, sleep, endDate: throughDate }),
  ]);
  if (etfResult.status === 'rejected') {
    logger.warn(`ETF source unavailable; keeping the last complete snapshot: ${etfResult.reason}`);
  }
  if (fundResult.status === 'rejected') {
    logger.warn(`Fund source unavailable; keeping the last confirmed NAV: ${fundResult.reason}`);
  }
  if (historyResult.status === 'rejected') {
    logger.warn(`Historical source unavailable; keeping the existing confirmed curve: ${historyResult.reason}`);
  }
  if (etfResult.status === 'rejected' && historyResult.status === 'rejected') {
    throw new AggregateError(
      [etfResult.reason, historyResult.reason],
      'No usable ETF source; refusing to report a successful stale update',
    );
  }

  const fundRows = fundResult.status === 'fulfilled' ? fundResult.value : [];
  const newFund = fundRows.length ? {
    entry: fundEntryNav,
    nav: fundRows.at(-1).nav,
    pre: (fundRows.at(-2) ?? fundRows.at(-1)).nav,
    date: fundRows.at(-1).date,
  } : { ...oldFund, entry: fundEntryNav };

  let market = oldMarket;
  let history = oldHistory.map(point => ({ ...point }));
  const cost = portfolioCost(oldMarket);
  const oldMarketDate = new Set(Object.values(oldMarket).map(item => item.date));
  if (oldMarketDate.size !== 1) throw new Error('Existing ETF snapshot has mixed dates');
  const previousDate = [...oldMarketDate][0];

  // Correct the most recent point when its fund NAV was published after the ETF close.
  const lastPoint = history.at(-1);
  const confirmedFundForPreviousDate = fundRows.find(row => row.date === previousDate);
  if (lastPoint?.date === previousDate && confirmedFundForPreviousDate) {
    lastPoint.nav = portfolioNav(oldMarket, confirmedFundForPreviousDate.nav, cost);
  }

  if (etfResult.status === 'fulfilled') {
    const snapshots = etfResult.value;
    const quoteDate = snapshots[0].date;
    if (quoteDate <= throughDate && quoteDate > previousDate) {
      market = Object.fromEntries(snapshots.map(snapshot => [snapshot.code, {
        entry: oldMarket[snapshot.code].entry,
        price: snapshot.price,
        pre: snapshot.pre,
        date: quoteDate,
      }]));
      history.push({
        date: quoteDate,
        nav: portfolioNav(market, fundNavOn(fundRows, quoteDate, newFund), cost),
      });
    }
  }

  // Rebuild the curve from a complete common trading calendar. This fills any
  // weekday missed by a failed workflow without ever inventing weekend points.
  if (historyResult.status === 'fulfilled') {
    const closesByCode = historyResult.value;
    const rebuildFrom = fundRows.length ? entryDate : oldHistory.at(-1).date;
    const commonDates = [...closesByCode.get(etfs[0].code).keys()]
      .filter(date => (fundRows.length ? date >= rebuildFrom : date > rebuildFrom) && date <= throughDate &&
        etfs.every(item => closesByCode.get(item.code)?.has(date)))
      .sort();
    if (commonDates.length) {
      const rebuiltHistory = commonDates.map(date => {
        const historicalMarket = Object.fromEntries(etfs.map(item => [item.code, {
          entry: oldMarket[item.code].entry,
          price: closesByCode.get(item.code).get(date),
        }]));
        return {
          date,
          nav: portfolioNav(historicalMarket, fundNavOn(fundRows, date, newFund), cost),
        };
      });
      if (commonDates[0] === entryDate) rebuiltHistory[0].nav = 1;
      const mergedHistory = new Map(history.map(point => [point.date, point]));
      rebuiltHistory.forEach(point => mergedHistory.set(point.date, point));
      history = [...mergedHistory.values()].sort((a, b) => a.date.localeCompare(b.date));

      const latestDate = commonDates.at(-1);
      const currentMarketDate = [...new Set(Object.values(market).map(item => item.date))][0];
      if (latestDate > currentMarketDate) {
        const priorDate = commonDates.at(-2) ?? latestDate;
        market = Object.fromEntries(etfs.map(item => [item.code, {
          entry: oldMarket[item.code].entry,
          price: closesByCode.get(item.code).get(latestDate),
          pre: closesByCode.get(item.code).get(priorDate),
          date: latestDate,
        }]));
      }
    }
  }

  if (history.at(-1).date < oldHistory.at(-1).date) {
    throw new Error('Refusing to truncate confirmed portfolio history');
  }

  let html = replaceConstant(before, 'MARKET_FALLBACK', market);
  html = replaceConstant(html, 'HISTORY_FALLBACK', history);
  html = replaceConstant(html, 'FUND_FALLBACK', { [fundCode]: newFund });
  if (html === before) {
    logger.log(`No new confirmed trading-day data after ${history.at(-1).date}; no update needed.`);
    return { changed: false, date: history.at(-1).date };
  }
  await writeFile(indexPath, html, 'utf8');
  logger.log(`Updated through trading day ${history.at(-1).date}; fund NAV date ${newFund.date}.`);
  return { changed: true, date: history.at(-1).date, fundDate: newFund.date };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await updatePortfolio();
}

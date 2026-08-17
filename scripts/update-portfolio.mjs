import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultIndexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const fundCode = '009803';
const fundAmount = 6850;
const fundEntryNav = 1.3263;
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

async function latestFundRows({ fetchFn, sleep, now }) {
  const url = new URL('https://api.fund.eastmoney.com/f10/lsjz');
  url.search = new URLSearchParams({
    fundCode, pageIndex: '1', pageSize: '20', startDate: '', endDate: shanghaiDate(now),
  });
  const payload = await fetchJson(url, {
    fetchFn,
    sleep,
    headers: { Referer: 'https://fundf10.eastmoney.com/' },
  });
  const rows = payload?.Data?.LSJZList ?? [];
  const normalized = rows
    .map(row => ({ date: row.FSRQ, nav: Number(row.DWJZ) }))
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.nav) && row.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!normalized.length) throw new Error(`No valid NAV history for ${fundCode}`);
  return normalized;
}

function fundNavOn(rows, date, fallback) {
  const row = rows.filter(item => item.date <= date).at(-1);
  if (row) return row.nav;
  if (fallback.date <= date) return fallback.nav;
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

  const [etfResult, fundResult] = await Promise.allSettled([
    latestEtfSnapshot({ fetchFn, sleep }),
    latestFundRows({ fetchFn, sleep, now }),
  ]);
  if (etfResult.status === 'rejected') {
    logger.warn(`ETF source unavailable; keeping the last complete snapshot: ${etfResult.reason}`);
  }
  if (fundResult.status === 'rejected') {
    logger.warn(`Fund source unavailable; keeping the last confirmed NAV: ${fundResult.reason}`);
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
    if (quoteDate <= confirmedThrough(now) && quoteDate > previousDate) {
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

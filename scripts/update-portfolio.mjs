import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('../index.html', import.meta.url));
const entryDate = '2026-07-28';
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const shanghaiParts = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date());
const shanghaiMinutes = Number(shanghaiParts.find(part => part.type === 'hour')?.value) * 60
  + Number(shanghaiParts.find(part => part.type === 'minute')?.value);
const confirmedThrough = shanghaiMinutes >= 15 * 60
  ? today
  : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
      .format(new Date(Date.now() - 24 * 60 * 60 * 1000));
const fundCode = '009803';
const fundAmount = 6850;
const fundEntryNav = 1.3263;
const etfs = [
  ['512890', 2800, '1'], ['159915', 2800, '0'], ['513500', 1400, '1'],
  ['513100', 1100, '1'], ['511130', 600, '1'], ['159985', 1100, '0'],
  ['159980', 2000, '0'], ['159981', 1600, '0'], ['518880', 200, '1'],
].map(([code, units, market]) => ({ code, units, market }));

async function json(url, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'User-Agent': 'Mozilla/5.0 portfolio-dashboard-updater/1.0',
          ...headers,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 8) await new Promise(resolve => setTimeout(resolve, attempt * 2500));
    }
  }
  throw lastError;
}

async function etfHistory(item) {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.search = new URLSearchParams({
    secid: `${item.market}.${item.code}`, klt: '101', fqt: '0',
    beg: entryDate.replaceAll('-', ''), end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53',
  });
  const payload = await json(url);
  const rows = payload?.data?.klines ?? [];
  if (!rows.length) throw new Error(`No ETF history for ${item.code}`);
  item.prices = new Map(rows.map(row => {
    const [date, , close] = row.split(',');
    return [date, Number(close)];
  }));
  return item;
}

async function fundHistory() {
  const url = new URL('https://api.fund.eastmoney.com/f10/lsjz');
  url.search = new URLSearchParams({
    fundCode, pageIndex: '1', pageSize: '100',
    startDate: entryDate, endDate: today,
  });
  const payload = await json(url, { Referer: 'https://fundf10.eastmoney.com/' });
  const rows = payload?.Data?.LSJZList ?? [];
  if (!rows.length) throw new Error(`No fund history for ${fundCode}`);
  return rows
    .map(row => ({ date: row.FSRQ, nav: Number(row.DWJZ) }))
    .filter(row => Number.isFinite(row.nav))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function latestFundOn(rows, date) {
  const candidates = rows.filter(row => row.date <= date);
  if (!candidates.length) throw new Error(`No fund NAV on or before ${date}`);
  return candidates.at(-1);
}

console.log(`Loading ${fundCode} NAV history...`);
const fundRows = await fundHistory();
const loadedEtfs = [];
for (const item of etfs) {
  console.log(`Loading ${item.code} daily closes...`);
  loadedEtfs.push(await etfHistory(item));
  await new Promise(resolve => setTimeout(resolve, 1200));
}

let dates = [...loadedEtfs[0].prices.keys()];
for (const item of loadedEtfs.slice(1)) dates = dates.filter(date => item.prices.has(date));
dates = dates.filter(date => date >= entryDate && date <= confirmedThrough).sort();
if (!dates.length) throw new Error('No common ETF trading dates');

const latestDate = dates.at(-1);
const publishedFundEntry = latestFundOn(fundRows, entryDate);
if (publishedFundEntry.nav !== fundEntryNav) {
  console.warn(
    `Ignoring published ${fundCode} entry NAV ${publishedFundEntry.nav}; ` +
    `the portfolio entry NAV is fixed at ${fundEntryNav}.`,
  );
}
const fundEntry = fundEntryNav;
const fundLatest = fundRows.at(-1);
const fundPrevious = fundRows.at(-2) ?? fundLatest;
const fundUnits = fundAmount / fundEntry;

let cost = fundAmount;
for (const item of loadedEtfs) {
  const entry = item.prices.get(entryDate);
  if (!entry) throw new Error(`Missing ${item.code} entry close`);
  item.entry = entry;
  cost += entry * item.units + Math.max(entry * item.units * 0.0001, 5);
}

const valueOn = date => {
  const etfValue = loadedEtfs.reduce(
    (sum, item) => sum + item.prices.get(date) * item.units,
    0,
  );
  return etfValue + latestFundOn(fundRows, date).nav * fundUnits;
};

const history = dates.map(date => ({
  date,
  nav: date === entryDate ? 1 : valueOn(date) / cost,
}));

const market = Object.fromEntries(loadedEtfs.map(item => {
  const index = dates.length - 1;
  return [item.code, {
    price: item.prices.get(dates[index]),
    pre: item.prices.get(dates[Math.max(0, index - 1)]),
    date: latestDate,
  }];
}));

const fundFallback = {
  [fundCode]: {
    entry: fundEntry,
    nav: fundLatest.nav,
    pre: fundPrevious.nav,
    date: fundLatest.date,
  },
};

let html = await readFile(indexPath, 'utf8');
html = html
  .replace(/const MARKET_FALLBACK=.*?;/, `const MARKET_FALLBACK=${JSON.stringify(market)};`)
  .replace(/const HISTORY_FALLBACK=.*?;/, `const HISTORY_FALLBACK=${JSON.stringify(history)};`)
  .replace(/const FUND_FALLBACK=.*?;/, `const FUND_FALLBACK=${JSON.stringify(fundFallback)};`);

const before = await readFile(indexPath, 'utf8');
if (html === before) {
  console.log(`No new trading-day data after ${latestDate}; no update needed.`);
} else {
  await writeFile(indexPath, html, 'utf8');
  console.log(`Updated through trading day ${latestDate}; fund NAV date ${fundLatest.date}.`);
}

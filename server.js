const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3460);
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const FUNDAMENTALS_TTL_MS = 12 * 60 * 60 * 1000;
const CHART_TTL_MS = 5 * 60 * 1000;
const fundamentalsCache = new Map();
const chartCache = new Map();
const chartInflight = new Map();

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          "accept": "application/json,*/*",
          "accept-language": "en-US,en;q=0.9",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

function httpsText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": USER_AGENT,
          "accept": "application/json,*/*",
          "accept-language": "en-US,en;q=0.9",
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

function normalizeSymbol(value) {
  return String(value || "SPY")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 16) || "SPY";
}

function parseYahoo(json, symbol) {
  const result = json?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp)) throw new Error("Yahoo response has no chart data.");
  const quote = result.indicators?.quote?.[0] || {};
  const bars = result.timestamp
    .map((time, index) => ({
      date: new Date(time * 1000).toISOString().slice(0, 10),
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index] || 0),
    }))
    .filter((bar) =>
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close)
    );
  if (!bars.length) throw new Error("No usable bars parsed.");
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  return {
    symbol,
    label: result.meta?.longName || result.meta?.shortName || symbol,
    currency: result.meta?.currency || "USD",
    source: "Yahoo Finance chart API",
    latestDate: last.date,
    latestClose: last.close,
    change: last.close - prev.close,
    changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
    bars,
  };
}

function parsePriceText(value) {
  const number = Number(String(value || "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function formatNasdaqDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStartDate(range) {
  const now = new Date();
  const start = new Date(now);
  if (range === "5d") start.setDate(start.getDate() - 7);
  else if (range === "1mo") start.setMonth(start.getMonth() - 1);
  else if (range === "3mo") start.setMonth(start.getMonth() - 3);
  else if (range === "6mo") start.setMonth(start.getMonth() - 6);
  else if (range === "ytd") return new Date(now.getFullYear(), 0, 1);
  else if (range === "1y") start.setFullYear(start.getFullYear() - 1);
  else if (range === "2y") start.setFullYear(start.getFullYear() - 2);
  else if (range === "5y") start.setFullYear(start.getFullYear() - 5);
  else start.setFullYear(start.getFullYear() - 2);
  return start;
}

function parseNasdaqHistoricalRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const close = parsePriceText(row.close);
      const open = parsePriceText(row.open);
      const high = parsePriceText(row.high);
      const low = parsePriceText(row.low);
      const volume = parsePriceText(row.volume);
      if (![close, open, high, low].every(Number.isFinite)) return null;
      const [month, day, year] = String(row.date || "").split("/");
      const date = year && month && day ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : null;
      if (!date) return null;
      return { date, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    })
    .filter(Boolean)
    .reverse();
}

function parseMetricText(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /^(-|--|N\/A|NA)$/i.test(raw)) return NaN;
  const multiplier = /t$/i.test(raw) ? 1e12 : /b$/i.test(raw) ? 1e9 : /m$/i.test(raw) ? 1e6 : /k$/i.test(raw) ? 1e3 : 1;
  const number = Number(raw.replace(/[$,%\s,]/g, "").replace(/[TBMK]$/i, ""));
  return Number.isFinite(number) ? number * multiplier : NaN;
}

function rawNumber(item) {
  if (item == null) return NaN;
  if (typeof item === "number") return item;
  if (typeof item === "object") {
    if (Number.isFinite(Number(item.raw))) return Number(item.raw);
    if (Number.isFinite(Number(item.value))) return Number(item.value);
    if (typeof item.fmt === "string") return parseMetricText(item.fmt);
  }
  return parseMetricText(item);
}

function summaryValue(summary, key) {
  return summary?.[key]?.value ?? summary?.[key] ?? null;
}

function parseFinancialRows(table, scale = 1) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const output = {};
  rows.forEach((row) => {
    const name = String(row.value1 || row.name || "").trim().toLowerCase();
    const latest = parseMetricText(row.value2) * scale;
    const previous = parseMetricText(row.value3) * scale;
    if (!name || !Number.isFinite(latest)) return;
    output[name] = { latest, previous };
  });
  return output;
}

function rowValue(rows, patterns) {
  const found = Object.entries(rows).find(([name]) => patterns.some((pattern) => pattern.test(name)));
  return found?.[1] || null;
}

function pctFromRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return NaN;
  return Math.abs(number) <= 1 ? number * 100 : number;
}

function compactFundamentals(payload) {
  const clean = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (value == null || value === "") return;
    if (typeof value === "number" && !Number.isFinite(value)) return;
    clean[key] = value;
  });
  return clean;
}

async function tryNasdaqAssetClasses(assetClasses, callback) {
  let lastError = null;
  for (const assetClass of assetClasses) {
    try {
      return await callback(assetClass);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Nasdaq request failed.");
}

async function fetchNasdaqQuote(symbol) {
  const apiSymbol = symbol.replace(/^\^/, "");
  const headers = {
    "referer": "https://www.nasdaq.com/",
    "origin": "https://www.nasdaq.com",
  };
  const { infoText, chartText, assetClass } = await tryNasdaqAssetClasses(["stocks", "etf"], async (candidate) => {
    const [nextInfoText, nextChartText] = await Promise.all([
      httpsText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/info?assetclass=${candidate}`, headers),
      httpsText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/chart?assetclass=${candidate}`, headers).catch(() => ""),
    ]);
    const probe = JSON.parse(nextInfoText)?.data || {};
    const probePrice = parsePriceText(probe.primaryData?.lastSalePrice);
    if (!Number.isFinite(probePrice) || probePrice <= 0) throw new Error(`Nasdaq ${candidate} quote has no valid price.`);
    return { infoText: nextInfoText, chartText: nextChartText, assetClass: candidate };
  });
  const info = JSON.parse(infoText);
  const chart = chartText ? JSON.parse(chartText) : {};
  const data = info?.data || {};
  const chartData = chart?.data || {};
  const latestClose = parsePriceText(data.primaryData?.lastSalePrice || chartData.lastSalePrice);
  if (!Number.isFinite(latestClose) || latestClose <= 0) throw new Error("Nasdaq response has no latest price.");
  const change = parsePriceText(data.primaryData?.netChange || chartData.netChange);
  const changePctRaw = parsePriceText(data.primaryData?.percentageChange || chartData.percentageChange);
  const volume = parsePriceText(data.primaryData?.volume || chartData.volume);
  const points = Array.isArray(chartData.chart) ? chartData.chart : [];
  const bars = points
    .map((point) => {
      const close = parsePriceText(point?.z?.value ?? point?.y);
      const date = Number.isFinite(Number(point?.x))
        ? new Date(Number(point.x)).toISOString()
        : new Date().toISOString();
      if (!Number.isFinite(close)) return null;
      return {
        date,
        open: close,
        high: close,
        low: close,
        close,
        volume: 0,
      };
    })
    .filter(Boolean);
  if (!bars.length) {
    bars.push({
      date: new Date().toISOString(),
      open: latestClose,
      high: latestClose,
      low: latestClose,
      close: latestClose,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  const last = bars[bars.length - 1];
  last.close = latestClose;
  last.high = Math.max(last.high, latestClose);
  last.low = Math.min(last.low, latestClose);
  if (Number.isFinite(volume)) last.volume = volume;
  return {
    symbol,
    label: data.companyName || chartData.company || symbol,
    currency: "USD",
    source: "Nasdaq quote API",
    latestDate: String(data.primaryData?.lastTradeTimestamp || chartData.timeAsOf || last.date),
    latestClose,
    change: Number.isFinite(change) ? change : 0,
    changePct: Number.isFinite(changePctRaw) ? changePctRaw : 0,
    bars,
    delayed: data.primaryData?.isRealTime === false || true,
    assetClass,
  };
}

async function fetchNasdaqHistorical(symbol, range = "2y") {
  const apiSymbol = symbol.replace(/^\^/, "");
  const headers = {
    "referer": "https://www.nasdaq.com/",
    "origin": "https://www.nasdaq.com",
  };
  const fromdate = formatNasdaqDate(rangeStartDate(range));
  const todate = formatNasdaqDate(new Date());
  const { first, assetClass } = await tryNasdaqAssetClasses(["stocks", "etf"], async (candidate) => {
    const text = await httpsText(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/historical?assetclass=${candidate}&fromdate=${encodeURIComponent(fromdate)}&todate=${encodeURIComponent(todate)}&offset=0`,
      headers
    );
    const data = JSON.parse(text)?.data || {};
    const rows = parseNasdaqHistoricalRows(data?.tradesTable?.rows);
    if (!rows.length) throw new Error(`Nasdaq ${candidate} historical has no rows.`);
    return { first: data, assetClass: candidate };
  });
  const fetchPage = async (offset) => {
    const text = await httpsText(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/historical?assetclass=${assetClass}&fromdate=${encodeURIComponent(fromdate)}&todate=${encodeURIComponent(todate)}&offset=${offset}`,
      headers
    );
    return JSON.parse(text)?.data || {};
  };
  const firstRows = parseNasdaqHistoricalRows(first?.tradesTable?.rows);
  const total = Number(first?.totalRecords) || firstRows.length;
  const pageSize = Math.max(1, firstRows.length);
  let rows = [...firstRows];
  for (let offset = pageSize; offset < total; offset += pageSize) {
    const next = await fetchPage(offset);
    rows = rows.concat(parseNasdaqHistoricalRows(next?.tradesTable?.rows));
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error("Nasdaq historical response has no usable rows.");
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  return {
    symbol,
    label: symbol,
    currency: "USD",
    source: "Nasdaq historical API",
    latestDate: last.date,
    latestClose: last.close,
    change: last.close - prev.close,
    changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
    bars: rows,
    delayed: true,
    assetClass,
  };
}

async function fetchChart(symbol, range = "2y") {
  const key = `${normalizeSymbol(symbol)}:${range}`;
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.time < CHART_TTL_MS) {
    return cached.payload;
  }
  if (chartInflight.has(key)) return chartInflight.get(key);
  const task = (async () => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
    try {
      const payload = parseYahoo(await httpsJson(url), symbol);
      chartCache.set(key, { time: Date.now(), payload });
      return payload;
    } catch (error) {
      const historical = await fetchNasdaqHistorical(symbol, range).catch(() => null);
      if (historical) {
        historical.warning = `Yahoo chart failed (${error.message}); showing Nasdaq historical data instead.`;
        chartCache.set(key, { time: Date.now(), payload: historical });
        return historical;
      }
      const quote = await fetchNasdaqQuote(symbol);
      quote.warning = `Yahoo chart failed (${error.message}); showing Nasdaq intraday quote data instead.`;
      chartCache.set(key, { time: Date.now(), payload: quote });
      return quote;
    }
  })();
  chartInflight.set(key, task);
  try {
    return await task;
  } finally {
    chartInflight.delete(key);
  }
}

async function fetchYahooFundamentals(symbol) {
  const modules = [
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "financialData",
    "earningsTrend",
  ].join(",");
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  const json = await httpsJson(url);
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error("Yahoo fundamentals response has no data.");
  const detail = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const financial = result.financialData || {};
  const trend = result.earningsTrend?.trend?.find((item) => item?.period === "+1y") || {};
  return compactFundamentals({
    symbol,
    label: result.price?.longName || result.price?.shortName || symbol,
    source: "Yahoo Finance quoteSummary API",
    marketCap: rawNumber(result.price?.marketCap) || rawNumber(detail.marketCap),
    trailingPE: rawNumber(detail.trailingPE) || rawNumber(stats.trailingPE),
    forwardPE: rawNumber(stats.forwardPE) || rawNumber(detail.forwardPE),
    pegRatio: rawNumber(stats.pegRatio),
    priceToBook: rawNumber(stats.priceToBook),
    trailingEps: rawNumber(stats.trailingEps),
    forwardEps: rawNumber(stats.forwardEps) || rawNumber(trend.earningsEstimate?.avg),
    dividendYieldPct: pctFromRatio(rawNumber(detail.dividendYield)),
    annualDividend: rawNumber(detail.dividendRate),
    beta: rawNumber(detail.beta) || rawNumber(stats.beta),
    targetMeanPrice: rawNumber(financial.targetMeanPrice),
    currentPrice: rawNumber(financial.currentPrice) || rawNumber(result.price?.regularMarketPrice),
    revenueGrowthPct: pctFromRatio(rawNumber(financial.revenueGrowth)),
    earningsGrowthPct: pctFromRatio(rawNumber(financial.earningsGrowth)),
    returnOnEquityPct: pctFromRatio(rawNumber(financial.returnOnEquity)),
    profitMarginPct: pctFromRatio(rawNumber(financial.profitMargins)),
  });
}

async function fetchNasdaqFundamentals(symbol) {
  const apiSymbol = symbol.replace(/^\^/, "");
  const headers = {
    "referer": "https://www.nasdaq.com/",
    "origin": "https://www.nasdaq.com",
  };
  const [summaryText, financialText] = await Promise.all([
    httpsText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/summary?assetclass=stocks`, headers),
    httpsText(`https://api.nasdaq.com/api/company/${encodeURIComponent(apiSymbol)}/financials?frequency=1`, headers).catch(() => ""),
  ]);
  const summary = JSON.parse(summaryText)?.data || {};
  const summaryData = summary.summaryData || {};
  const financial = financialText ? JSON.parse(financialText)?.data || {} : {};
  const income = parseFinancialRows(financial.incomeStatementTable, 1000);
  const ratios = parseFinancialRows(financial.financialRatiosTable);
  const revenue = rowValue(income, [/total revenue/, /^revenue$/]);
  const netIncome = rowValue(income, [/net income/]);
  const eps = rowValue(ratios, [/earnings per share/, /\beps\b/]);
  const pe = rowValue(ratios, [/p\/e/, /price.*earnings/]);
  const roe = rowValue(ratios, [/return on equity/, /\broe\b/]);
  const margin = rowValue(ratios, [/profit margin/, /net margin/]);
  const currentPrice = parseMetricText(summary.primaryData?.lastSalePrice || summaryValue(summaryData, "PreviousClose"));
  const target = parseMetricText(summaryValue(summaryData, "OneYrTarget"));
  const marketCap = parseMetricText(summaryValue(summaryData, "MarketCap"));
  const sharesOutstanding = Number.isFinite(marketCap) && Number.isFinite(currentPrice) && currentPrice > 0 ? marketCap / currentPrice : NaN;
  const revenueGrowthPct = revenue && Number.isFinite(revenue.previous) && revenue.previous
    ? ((revenue.latest - revenue.previous) / Math.abs(revenue.previous)) * 100
    : NaN;
  const earningsGrowthPct = netIncome && Number.isFinite(netIncome.previous) && netIncome.previous
    ? ((netIncome.latest - netIncome.previous) / Math.abs(netIncome.previous)) * 100
    : NaN;
  const trailingEps = Number.isFinite(eps?.latest)
    ? eps.latest
    : netIncome && Number.isFinite(sharesOutstanding) && sharesOutstanding > 0
      ? netIncome.latest / sharesOutstanding
      : NaN;
  const trailingPE = Number.isFinite(pe?.latest)
    ? pe.latest
    : Number.isFinite(currentPrice) && Number.isFinite(trailingEps) && trailingEps > 0
      ? currentPrice / trailingEps
      : NaN;
  const pegRatio = Number.isFinite(trailingPE) && Number.isFinite(earningsGrowthPct) && earningsGrowthPct > 0
    ? trailingPE / earningsGrowthPct
    : NaN;
  return compactFundamentals({
    symbol,
    label: summary.companyName || summary.symbol || symbol,
    source: "Nasdaq summary and financials APIs",
    sector: summaryValue(summaryData, "Sector"),
    industry: summaryValue(summaryData, "Industry"),
    marketCap,
    sharesOutstanding,
    trailingPE,
    pegRatio,
    trailingEps,
    dividendYieldPct: parseMetricText(summaryValue(summaryData, "Yield")),
    annualDividend: parseMetricText(summaryValue(summaryData, "AnnualizedDividend")),
    targetMeanPrice: target,
    currentPrice,
    revenueGrowthPct,
    earningsGrowthPct,
    returnOnEquityPct: roe?.latest,
    profitMarginPct: margin?.latest,
  });
}

async function fetchFundamentals(symbol, force = false) {
  const key = normalizeSymbol(symbol);
  const cached = fundamentalsCache.get(key);
  if (!force && cached && Date.now() - cached.time < FUNDAMENTALS_TTL_MS) return cached.payload;
  let payload;
  try {
    payload = await fetchYahooFundamentals(key);
  } catch (yahooError) {
    payload = await fetchNasdaqFundamentals(key);
    payload.warning = `Yahoo fundamentals failed (${yahooError.message}); showing Nasdaq fundamentals where available.`;
  }
  fundamentalsCache.set(key, { time: Date.now(), payload });
  return payload;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/api/chart") {
    const symbol = normalizeSymbol(url.searchParams.get("symbol"));
    const range = String(url.searchParams.get("range") || "2y");
    try {
      sendJson(res, 200, await fetchChart(symbol, range));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/fundamentals") {
    const symbol = normalizeSymbol(url.searchParams.get("symbol"));
    try {
      sendJson(res, 200, await fetchFundamentals(symbol, url.searchParams.get("force") === "1"));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Stock analysis app running at http://localhost:${PORT}`);
});

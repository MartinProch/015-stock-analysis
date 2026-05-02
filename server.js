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

async function fetchNasdaqQuote(symbol) {
  const apiSymbol = symbol.replace(/^\^/, "");
  const headers = {
    "referer": "https://www.nasdaq.com/",
    "origin": "https://www.nasdaq.com",
  };
  const [infoText, chartText] = await Promise.all([
    httpsText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/info?assetclass=stocks`, headers),
    httpsText(`https://api.nasdaq.com/api/quote/${encodeURIComponent(apiSymbol)}/chart?assetclass=stocks`, headers).catch(() => ""),
  ]);
  const info = JSON.parse(infoText);
  const chart = chartText ? JSON.parse(chartText) : {};
  const data = info?.data || {};
  const chartData = chart?.data || {};
  const latestClose = parsePriceText(data.primaryData?.lastSalePrice || chartData.lastSalePrice);
  if (!Number.isFinite(latestClose)) throw new Error("Nasdaq response has no latest price.");
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
  };
}

async function fetchChart(symbol, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
  try {
    return parseYahoo(await httpsJson(url), symbol);
  } catch (error) {
    const quote = await fetchNasdaqQuote(symbol);
    quote.warning = `Yahoo chart failed (${error.message}); showing Nasdaq quote data instead.`;
    return quote;
  }
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
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Stock analysis app running at http://localhost:${PORT}`);
});

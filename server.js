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

function buildSample(symbol) {
  const seed = [...symbol].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  let price = 120 + (seed % 90);
  const bars = [];
  const now = new Date();
  for (let i = 359; i >= 0; i -= 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const phase = (360 - i) / 18;
    const impulse = Math.sin(phase) * 2.2 + Math.sin(phase / 3) * 3.8;
    const drift = 0.035 + ((seed % 11) - 5) * 0.003;
    const open = price;
    price = Math.max(4, price * (1 + drift / 100) + impulse * 0.18 + Math.sin(i + seed) * 0.45);
    const close = price;
    const spread = Math.max(0.8, Math.abs(close - open) + 1.2 + ((i + seed) % 5) * 0.18);
    bars.push({
      date: date.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number((Math.max(open, close) + spread * 0.55).toFixed(2)),
      low: Number((Math.min(open, close) - spread * 0.45).toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Math.round(2_000_000 + Math.abs(Math.sin(phase)) * 8_000_000 + ((i + seed) % 17) * 110_000),
    });
  }
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  return {
    symbol,
    label: `${symbol} sample`,
    currency: "USD",
    source: "offline sample generated locally",
    latestDate: last.date,
    latestClose: last.close,
    change: last.close - prev.close,
    changePct: prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0,
    bars,
    offline: true,
  };
}

async function fetchChart(symbol, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`;
  try {
    return parseYahoo(await httpsJson(url), symbol);
  } catch (error) {
    const sample = buildSample(symbol);
    sample.warning = `Live fetch failed: ${error.message}`;
    return sample;
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

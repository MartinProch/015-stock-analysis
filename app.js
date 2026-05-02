const STORAGE_KEY = "stock-analysis-wavefront-lite-v1";
const DEFAULT_TICKERS = ["SPY", "AAPL", "MSFT", "TSLA"];
const WAVE_COLORS = {
  "0": "#7e8da0",
  "I": "#21d4d4",
  "II": "#f8c14a",
  "III": "#21c875",
  "IV": "#9b8cff",
  "V": "#4f8cff",
  "A": "#ef476f",
  "B": "#f8c14a",
  "C": "#ef476f",
};

const state = {
  tickers: [...DEFAULT_TICKERS],
  selected: "SPY",
  range: "2y",
  sort: "default",
  compareMetric: "rs3m",
  data: {},
  dataCache: {},
  analysis: {},
  fundamentals: {},
  tab: "waves",
  overlays: {
    waves: true,
    fibs: true,
    sr: true,
    zones: true,
    volume: true,
    divergence: true,
    wma50: false,
    wma200: true,
    profile: false,
    channel: false,
    measured: false,
    fibtime: false,
    candles: false,
  },
  positions: [],
  zoom: null,
  crosshair: null,
};

const refs = {
  form: document.getElementById("tickerForm"),
  input: document.getElementById("tickerInput"),
  watchlist: document.getElementById("watchlist"),
  sort: document.getElementById("sortSelect"),
  status: document.getElementById("statusLine"),
  timeframes: document.getElementById("timeframes"),
  overlays: document.getElementById("overlays"),
  canvas: document.getElementById("priceCanvas"),
  empty: document.getElementById("emptyState"),
  panel: document.getElementById("panelContent"),
  tabs: document.querySelector(".tabs"),
  resetZoom: document.getElementById("resetZoomBtn"),
};
const ctx = refs.canvas.getContext("2d");
let panStart = null;
const fundamentalsLoading = new Set();
const tooltipState = {
  target: null,
  text: "",
  timer: null,
  el: null,
};

function saveState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      tickers: state.tickers,
      selected: state.selected,
      range: state.range,
      sort: state.sort,
      compareMetric: state.compareMetric,
      overlays: state.overlays,
      positions: state.positions,
    })
  );
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (Array.isArray(saved.tickers) && saved.tickers.length) state.tickers = saved.tickers;
    if (saved.selected) state.selected = saved.selected;
    if (saved.range) state.range = saved.range;
    if (saved.sort) state.sort = saved.sort;
    if (saved.compareMetric) state.compareMetric = saved.compareMetric;
    if (saved.overlays) state.overlays = { ...state.overlays, ...saved.overlays };
    if (Array.isArray(saved.positions)) state.positions = saved.positions;
  } catch {
    // Ignore corrupt local workspace data.
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n >= 100 ? n.toFixed(2) : n >= 10 ? n.toFixed(2) : n.toFixed(3);
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function formatUnsignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(n < 10 ? 2 : 1)}%`;
}

function formatRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function formatCompactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function setStatus(text) {
  refs.status.textContent = text;
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 16);
}

async function fetchTicker(symbol) {
  const key = normalizeSymbol(symbol);
  const cached = state.dataCache[key]?.[state.range];
  if (cached) {
    state.data[key] = cached;
    state.analysis[key] = analyzeSymbol(cached.bars);
    return cached;
  }
  setStatus(`Loading ${symbol}...`);
  const response = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(state.range)}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  payload.bars = payload.bars.map((bar) => ({
    date: new Date(String(bar.date || "").includes("T") ? bar.date : `${bar.date}T00:00:00`),
    o: Number(bar.open),
    h: Number(bar.high),
    l: Number(bar.low),
    c: Number(bar.close),
    v: Number(bar.volume || 0),
  }));
  state.data[key] = payload;
  state.dataCache[key] = { ...(state.dataCache[key] || {}), [state.range]: payload };
  state.analysis[key] = analyzeSymbol(payload.bars);
  fetchFundamentals(key).catch(() => null);
  setStatus(`${key} loaded from ${payload.source || "market data"}${payload.warning ? " (fallback)" : ""}`);
  return payload;
}

async function fetchFundamentals(symbol, force = false) {
  const key = normalizeSymbol(symbol);
  if (!key || (!force && state.fundamentals[key]) || fundamentalsLoading.has(key)) return state.fundamentals[key] || null;
  fundamentalsLoading.add(key);
  try {
    const response = await fetch(`/api/fundamentals?symbol=${encodeURIComponent(key)}${force ? "&force=1" : ""}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.fundamentals[key] = payload;
    return payload;
  } finally {
    fundamentalsLoading.delete(key);
  }
}

function ensureCompareFundamentals() {
  const missing = state.tickers.filter((symbol) => !state.fundamentals[symbol] && !fundamentalsLoading.has(symbol));
  if (!missing.length) return;
  Promise.all(missing.map((symbol) => fetchFundamentals(symbol).catch(() => null))).then(() => {
    if (state.tab === "compare") renderPanel();
  });
}

function thresholdFor(bars) {
  if (bars.length < 3) return 0.035;
  const closes = bars.map((bar) => bar.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const rangePct = (max - min) / Math.max(1, min);
  return Math.min(0.09, Math.max(0.025, rangePct / 11));
}

function zigzag(bars, threshold = thresholdFor(bars)) {
  if (bars.length < 5) return [];
  const pivots = [];
  let trend = 0;
  let extreme = { index: 0, price: bars[0].c };

  for (let i = 1; i < bars.length; i += 1) {
    const high = bars[i].h;
    const low = bars[i].l;
    if (trend >= 0 && high >= extreme.price) extreme = { index: i, price: high };
    if (trend <= 0 && low <= extreme.price) extreme = { index: i, price: low };
    if (trend >= 0 && (extreme.price - low) / extreme.price >= threshold) {
      pivots.push({ index: extreme.index, date: bars[extreme.index].date, price: extreme.price, type: "H" });
      trend = -1;
      extreme = { index: i, price: low };
    } else if (trend <= 0 && (high - extreme.price) / extreme.price >= threshold) {
      pivots.push({ index: extreme.index, date: bars[extreme.index].date, price: extreme.price, type: "L" });
      trend = 1;
      extreme = { index: i, price: high };
    }
  }

  if (pivots.length && pivots[pivots.length - 1].index !== extreme.index) {
    pivots.push({
      index: extreme.index,
      date: bars[extreme.index].date,
      price: extreme.price,
      type: trend >= 0 ? "H" : "L",
    });
  }
  return pivots.filter((pivot, index, all) => index === 0 || pivot.index !== all[index - 1].index);
}

function buildFibLevels(low, high, direction) {
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];
  const range = high - low || 1;
  return ratios.map((ratio) => ({
    ratio,
    label: ratio > 1 ? `${ratio.toFixed(3)}x` : `${(ratio * 100).toFixed(1)}%`,
    price: direction === "down" ? high - range * ratio : low + range * ratio,
    extension: ratio > 1,
  }));
}

function detectWaves(bars) {
  const pivots = zigzag(bars);
  if (pivots.length < 4) return null;
  const candidates = [];

  for (let start = 0; start <= pivots.length - 6; start += 1) {
    const pts = pivots.slice(start, start + 6);
    if (!pts.every((point, index) => index === 0 || point.type !== pts[index - 1].type)) continue;
    const up = pts[0].type === "L";
    const [p0, p1, p2, p3, p4, p5] = pts;
    const w1 = Math.abs(p1.price - p0.price);
    const w2 = Math.abs(p2.price - p1.price);
    const w3 = Math.abs(p3.price - p2.price);
    const w4 = Math.abs(p4.price - p3.price);
    const w5 = Math.abs(p5.price - p4.price);
    const rules = up
      ? [
          { text: "Wave 2 above start", ok: p2.price > p0.price },
          { text: "Wave 3 not shortest", ok: w3 !== Math.min(w1, w3, w5) },
          { text: "Wave 4 above wave 1", ok: p4.price > p1.price },
        ]
      : [
          { text: "Wave 2 below start", ok: p2.price < p0.price },
          { text: "Wave 3 not shortest", ok: w3 !== Math.min(w1, w3, w5) },
          { text: "Wave 4 below wave 1", ok: p4.price < p1.price },
        ];
    if (!rules.every((rule) => rule.ok) || !w1 || !w3 || !w5) continue;
    const high = Math.max(p0.price, p5.price);
    const low = Math.min(p0.price, p5.price);
    const amplitude = Math.abs(p5.price - p0.price) / Math.max(1, p0.price);
    candidates.push({
      amplitude,
      result: {
        pattern: "Impulse",
        direction: up ? "up" : "down",
        currentWave: start + 6 >= pivots.length ? "V" : "post-V",
        complete: start + 6 < pivots.length,
        pivots: [
          { ...p0, label: "0", color: WAVE_COLORS["0"] },
          { ...p1, label: "I", color: WAVE_COLORS["I"] },
          { ...p2, label: "II", color: WAVE_COLORS["II"] },
          { ...p3, label: "III", color: WAVE_COLORS["III"] },
          { ...p4, label: "IV", color: WAVE_COLORS["IV"] },
          { ...p5, label: "V", color: WAVE_COLORS["V"] },
        ],
        rules,
        fibLevels: buildFibLevels(low, high, up ? "up" : "down"),
        waveData: { w1, w2, w3, w4, w5, p0, p1, p2, p3, p4, p5 },
      },
    });
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.amplitude - a.amplitude);
    return candidates[0].result;
  }

  const pts = pivots.slice(-4);
  if (pts.length === 4 && pts.every((point, index) => index === 0 || point.type !== pts[index - 1].type)) {
    const [p0, p1, p2, p3] = pts;
    const up = p0.type === "L";
    const high = Math.max(p0.price, p3.price);
    const low = Math.min(p0.price, p3.price);
    return {
      pattern: "Correction",
      direction: up ? "up" : "down",
      currentWave: "C",
      complete: false,
      pivots: [
        { ...p0, label: "0", color: WAVE_COLORS["0"] },
        { ...p1, label: "A", color: WAVE_COLORS["A"] },
        { ...p2, label: "B", color: WAVE_COLORS["B"] },
        { ...p3, label: "C", color: WAVE_COLORS["C"] },
      ],
      rules: [
        { text: "A/B/C pivots alternate", ok: true },
        { text: "B is a retracement", ok: up ? p2.price < p1.price : p2.price > p1.price },
      ],
      fibLevels: buildFibLevels(low, high, up ? "up" : "down"),
      waveData: { p0, p1, p2, p3 },
    };
  }
  return null;
}

function waveConfidence(wave) {
  if (!wave) return 0;
  let score = 0;
  let total = 0;
  wave.rules.forEach((rule) => {
    total += 20;
    if (rule.ok) score += 20;
  });
  const data = wave.waveData || {};
  if (wave.pattern === "Impulse") {
    const w1 = Math.abs(data.w1 || 0);
    const w2 = Math.abs(data.w2 || 0);
    const w3 = Math.abs(data.w3 || 0);
    const w4 = Math.abs(data.w4 || 0);
    const w5 = Math.abs(data.w5 || 0);
    if (w1 && w3) {
      total += 20;
      const ratio = w3 / w1;
      score += ratio >= 1.5 && ratio <= 1.8 ? 20 : ratio >= 1 && ratio <= 2.618 ? 12 : 5;
    }
    if (w1 && w2) {
      total += 10;
      const retrace = w2 / w1;
      score += retrace >= 0.35 && retrace <= 0.8 ? 10 : retrace <= 0.9 ? 5 : 0;
    }
    if (w3 && w4) {
      total += 10;
      const retrace = w4 / w3;
      score += retrace >= 0.25 && retrace <= 0.65 ? 10 : retrace <= 0.78 ? 5 : 0;
    }
    if (w1 && w3 && w5) {
      total += 10;
      if (w3 >= w1 && w3 >= w5) score += 10;
    }
  }
  return total ? Math.round((score / total) * 100) : 50;
}

function calcRSISeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = bars[i].c - bars[i - 1].c;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < bars.length; i += 1) {
    const diff = bars[i].c - bars[i - 1].c;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function detectDivergence(bars, rsi, lookback = 80) {
  const start = Math.max(14, bars.length - lookback);
  const peaks = [];
  const troughs = [];
  const win = 3;
  for (let i = start + win; i < bars.length - win; i += 1) {
    let peak = true;
    let trough = true;
    for (let j = i - win; j <= i + win; j += 1) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) peak = false;
      if (bars[j].l <= bars[i].l) trough = false;
    }
    if (peak && rsi[i] != null) peaks.push(i);
    if (trough && rsi[i] != null) troughs.push(i);
  }
  if (peaks.length >= 2) {
    const a = peaks[peaks.length - 2];
    const b = peaks[peaks.length - 1];
    if (bars[b].h > bars[a].h && rsi[b] < rsi[a] - 2) return { type: "bearish", a, b, r1: rsi[a], r2: rsi[b] };
  }
  if (troughs.length >= 2) {
    const a = troughs[troughs.length - 2];
    const b = troughs[troughs.length - 1];
    if (bars[b].l < bars[a].l && rsi[b] > rsi[a] + 2) return { type: "bullish", a, b, r1: rsi[a], r2: rsi[b] };
  }
  return null;
}

function detectSupportResistance(bars, maxLevels = 6) {
  const pivots = [];
  const win = 4;
  for (let i = win; i < bars.length - win; i += 1) {
    let high = true;
    let low = true;
    for (let j = i - win; j <= i + win; j += 1) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) high = false;
      if (bars[j].l <= bars[i].l) low = false;
    }
    if (high) pivots.push({ price: bars[i].h, index: i, kind: "high" });
    if (low) pivots.push({ price: bars[i].l, index: i, kind: "low" });
  }
  const clusters = [];
  const used = new Set();
  pivots.forEach((pivot, index) => {
    if (used.has(index)) return;
    const cluster = [pivot];
    used.add(index);
    pivots.forEach((other, otherIndex) => {
      if (used.has(otherIndex)) return;
      if (Math.abs(other.price - pivot.price) / pivot.price <= 0.006) {
        cluster.push(other);
        used.add(otherIndex);
      }
    });
    if (cluster.length >= 2) {
      const price = cluster.reduce((sum, item) => sum + item.price, 0) / cluster.length;
      clusters.push({
        price,
        touches: cluster.length,
        lastIndex: Math.max(...cluster.map((item) => item.index)),
      });
    }
  });
  const current = bars[bars.length - 1]?.c || 0;
  return clusters
    .map((level) => ({
      ...level,
      role: level.price < current ? "support" : "resistance",
      score: level.touches * 2 + level.lastIndex / Math.max(1, bars.length),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxLevels)
    .sort((a, b) => b.price - a.price);
}

function buildForecast(wave, bars) {
  const current = bars[bars.length - 1]?.c;
  if (!wave || !Number.isFinite(current)) return null;
  const data = wave.waveData || {};
  if (wave.pattern === "Impulse" && data.p4 && data.w1) {
    const sign = wave.direction === "up" ? 1 : -1;
    const base = current;
    return {
      target618: base + sign * Math.abs(data.w1) * 0.618,
      target100: base + sign * Math.abs(data.w1),
      target1618: base + sign * Math.abs(data.w1) * 1.618,
      stop: data.p4.price,
      buyLow: wave.direction === "up" ? data.p4.price : current,
      buyHigh: wave.direction === "up" ? data.p4.price + Math.abs(data.w1) * 0.236 : current + Math.abs(data.w1) * 0.236,
    };
  }
  if (wave.pivots?.length >= 2) {
    const lastPivot = wave.pivots[wave.pivots.length - 1];
    const prevPivot = wave.pivots[wave.pivots.length - 2];
    const swing = Math.abs(lastPivot.price - prevPivot.price);
    const sign = current >= lastPivot.price ? 1 : -1;
    return {
      target618: current + sign * swing * 0.618,
      target100: current + sign * swing,
      target1618: current + sign * swing * 1.618,
      stop: prevPivot.price,
      buyLow: Math.min(current, lastPivot.price),
      buyHigh: Math.max(current, lastPivot.price),
    };
  }
  const fib618 = wave.fibLevels?.find((item) => item.ratio === 0.618)?.price;
  return { target618: fib618, target100: current, target1618: wave.fibLevels?.find((item) => item.ratio === 1.618)?.price, stop: wave.pivots?.[0]?.price };
}

function analyzeSymbol(bars) {
  const wave = detectWaves(bars);
  const rsiSeries = calcRSISeries(bars);
  const latestRsi = [...rsiSeries].reverse().find((value) => value != null) ?? null;
  const divergence = detectDivergence(bars, rsiSeries);
  const sr = detectSupportResistance(bars);
  const confidence = waveConfidence(wave);
  const forecast = buildForecast(wave, bars);
  return { wave, confidence, rsiSeries, latestRsi, divergence, sr, forecast };
}

function getVisibleFibOverlay(bars, analysis) {
  if (analysis?.wave?.pivots?.length >= 2) {
    const anchor = analysis.wave.pivots[analysis.wave.pivots.length - 2];
    const current = bars[bars.length - 1]?.c;
    if (anchor && Number.isFinite(current) && Math.abs(current - anchor.price) > Math.max(1e-6, anchor.price * 0.0025)) {
      const direction = current >= anchor.price ? "up" : "down";
      return {
        source: "live",
        levels: buildFibLevels(Math.min(anchor.price, current), Math.max(anchor.price, current), direction),
      };
    }
  }
  if (analysis?.wave?.fibLevels?.length) {
    return {
      source: "wave",
      levels: analysis.wave.fibLevels,
    };
  }
  if (!Array.isArray(bars) || bars.length < 2) {
    return { source: "range", levels: [] };
  }
  let highBar = bars[0];
  let lowBar = bars[0];
  bars.forEach((bar) => {
    if (bar.h > highBar.h) highBar = bar;
    if (bar.l < lowBar.l) lowBar = bar;
  });
  const direction = highBar.date >= lowBar.date ? "up" : "down";
  return {
    source: "range",
    levels: buildFibLevels(lowBar.l, highBar.h, direction),
  };
}

function calcWMAValues(bars, period) {
  const output = new Array(bars.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < bars.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < period; j += 1) {
      sum += bars[i - j].c * (period - j);
    }
    output[i] = sum / denom;
  }
  return output;
}

function regressionChannel(bars) {
  if (!Array.isArray(bars) || bars.length < 12) return null;
  const n = bars.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = bars.reduce((sum, bar) => sum + bar.c, 0);
  const sumXY = bars.reduce((sum, bar, index) => sum + index * bar.c, 0);
  const sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  if (!denom) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const residuals = bars.map((bar, index) => bar.c - (intercept + slope * index));
  const sigma = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / n);
  return {
    center: (index) => intercept + slope * index,
    upper: (index) => intercept + slope * index + sigma * 1.5,
    lower: (index) => intercept + slope * index - sigma * 1.5,
    sigma,
  };
}

function detectCandlePatterns(bars) {
  const patterns = [];
  for (let i = 2; i < bars.length; i += 1) {
    const b = bars[i];
    const b1 = bars[i - 1];
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (!range) continue;
    const upper = b.h - Math.max(b.o, b.c);
    const lower = Math.min(b.o, b.c) - b.l;
    const isUp = b.c >= b.o;
    const priorDown = b1.c < b1.o;
    const priorUp = b1.c >= b1.o;
    if (body / range < 0.08) patterns.push({ index: i, label: "Doji", tone: "neutral" });
    else if (lower > body * 2.2 && upper < body * 0.7) patterns.push({ index: i, label: isUp ? "Hammer" : "Hanging", tone: isUp ? "bullish" : "bearish" });
    else if (priorDown && isUp && b.o <= b1.c && b.c >= b1.o) patterns.push({ index: i, label: "Engulf", tone: "bullish" });
    else if (priorUp && !isUp && b.o >= b1.c && b.c <= b1.o) patterns.push({ index: i, label: "Engulf", tone: "bearish" });
  }
  return patterns.slice(-10);
}

function measuredMoveTargets(wave, bars) {
  const pivots = wave?.pivots?.length ? wave.pivots : zigzag(bars).slice(-4);
  if (!pivots || pivots.length < 3) return null;
  const [a, b, c] = pivots.slice(-3);
  const ab = b.price - a.price;
  if (!Number.isFinite(ab) || !ab) return null;
  return {
    a,
    b,
    c,
    targets: [
      { ratio: 1, price: c.price + ab, label: "AB=CD" },
      { ratio: 1.272, price: c.price + ab * 1.272, label: "1.272x" },
      { ratio: 1.618, price: c.price + ab * 1.618, label: "1.618x" },
    ],
  };
}

function sortedTickers() {
  const list = [...state.tickers];
  if (state.sort === "score") {
    list.sort((a, b) => (state.analysis[b]?.confidence || 0) - (state.analysis[a]?.confidence || 0));
  } else if (state.sort === "change") {
    list.sort((a, b) => (state.data[b]?.changePct || 0) - (state.data[a]?.changePct || 0));
  } else if (state.sort === "rsi") {
    list.sort((a, b) => (state.analysis[b]?.latestRsi || 0) - (state.analysis[a]?.latestRsi || 0));
  }
  return list;
}

function renderWatchlist() {
  refs.watchlist.innerHTML = sortedTickers()
    .map((symbol) => {
      const data = state.data[symbol];
      const analysis = state.analysis[symbol];
      const changeClass = (data?.changePct || 0) > 0 ? "up" : (data?.changePct || 0) < 0 ? "down" : "neutral";
      return `
        <article class="ticker-card ${symbol === state.selected ? "active" : ""}" data-symbol="${symbol}">
          <div class="ticker-top">
            <span class="ticker-symbol">${symbol}</span>
            <span class="ticker-price">${data ? formatPrice(data.latestClose) : "..."}</span>
          </div>
          <div class="ticker-meta">
            <span class="${changeClass}">${data ? formatPct(data.changePct) : "not loaded"}</span>
            <span>score ${analysis ? analysis.confidence : "-"}</span>
          </div>
          <div class="ticker-meta">
            <span>${analysis?.wave ? `${analysis.wave.pattern} ${analysis.wave.currentWave}` : "No count"}</span>
            <span>RSI ${analysis?.latestRsi ? analysis.latestRsi.toFixed(1) : "-"}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function computeReturn(bars, lookback) {
  if (!Array.isArray(bars) || bars.length < 2) return NaN;
  const end = bars[bars.length - 1]?.c;
  const start = bars[Math.max(0, bars.length - 1 - lookback)]?.c;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return NaN;
  return ((end - start) / start) * 100;
}

const COMPARE_METRICS = [
  { key: "rs3m", label: "RS 3M", higherBetter: true, format: (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(1)} pts` : "-", tip: "Relative Strength 3M|3-month performance versus SPY in percentage points.|Positive means the stock outperformed the market over the same period." },
  { key: "return3m", label: "3M %", higherBetter: true, format: formatPct, tip: "3-Month Return|Price change over roughly one quarter.|Useful for checking medium-term momentum and trend leadership." },
  { key: "return1m", label: "1M %", higherBetter: true, format: formatPct, tip: "1-Month Return|Price change over the last month.|Good for recent acceleration or loss of momentum." },
  { key: "changePct", label: "1D %", higherBetter: true, format: formatPct, tip: "1-Day Change|Latest session percentage move.|Helpful for spotting short-term strength, weakness, and gaps." },
  { key: "marketCap", label: "Mkt Cap", higherBetter: true, format: formatCompactNumber, tip: "Market Capitalization|Share price multiplied by shares outstanding.|Shows company size and usually correlates with maturity and liquidity." },
  { key: "trailingPE", label: "P/E", higherBetter: false, format: formatRatio, tip: "Price to Earnings|Current price divided by trailing earnings per share.|Lower can mean cheaper valuation, but always compare with growth and sector norms." },
  { key: "forwardPE", label: "Fwd P/E", higherBetter: false, format: formatRatio, tip: "Forward P/E|Current price divided by expected next-year earnings.|Useful for seeing how expensive the stock looks against future estimates." },
  { key: "pegRatio", label: "PEG", higherBetter: false, format: formatRatio, tip: "PEG Ratio|P/E divided by earnings growth rate.|A quick way to compare valuation relative to growth; lower is usually better." },
  { key: "priceToBook", label: "P/B", higherBetter: false, format: formatRatio, tip: "Price to Book|Share price divided by book value per share.|More relevant for asset-heavy businesses than for software or platform companies." },
  { key: "trailingEps", label: "EPS", higherBetter: true, format: formatPrice, tip: "Trailing EPS|Earnings per share from the most recent trailing period.|Higher EPS generally supports stronger valuation and financial quality." },
  { key: "forwardEps", label: "Fwd EPS", higherBetter: true, format: formatPrice, tip: "Forward EPS|Analyst estimate for next-period earnings per share.|Compare it with trailing EPS to gauge expected growth." },
  { key: "dividendYieldPct", label: "Yield", higherBetter: true, format: formatUnsignedPct, tip: "Dividend Yield|Annual dividend divided by current share price.|Useful for income comparison, but very high yields can also signal stress." },
  { key: "targetUpsidePct", label: "Target", higherBetter: true, format: formatPct, tip: "Target Upside|Average analyst target relative to the current price.|Best used as context, not as a standalone trading signal." },
  { key: "revenueGrowthPct", label: "Rev Gr.", higherBetter: true, format: formatPct, tip: "Revenue Growth|Annual percentage growth in sales.|Shows demand and top-line expansion before margins and accounting effects." },
  { key: "earningsGrowthPct", label: "Earn Gr.", higherBetter: true, format: formatPct, tip: "Earnings Growth|Annual percentage growth in profit.|A strong reading suggests operating leverage or improving business quality." },
  { key: "returnOnEquityPct", label: "ROE", higherBetter: true, format: formatUnsignedPct, tip: "Return on Equity|Net income relative to shareholder equity.|Useful for measuring how efficiently management turns equity into profit." },
  { key: "profitMarginPct", label: "Margin", higherBetter: true, format: formatUnsignedPct, tip: "Net Margin|Profit as a percentage of revenue.|Higher margins usually mean more pricing power or better efficiency." },
  { key: "beta", label: "Beta", higherBetter: false, format: formatRatio, tip: "Beta|Sensitivity of the stock versus the broader market.|Above 1 usually means bigger swings than the index; below 1 means calmer behavior." },
  { key: "waveScore", label: "Wave", higherBetter: true, format: (value) => Number.isFinite(value) ? value.toFixed(0) : "-", tip: "Wave Score|Local confidence score from the Elliott-wave heuristic.|Treat it as a ranking aid, then validate the structure on the chart." },
  { key: "rsi", label: "RSI", higherBetter: true, format: (value) => Number.isFinite(value) ? value.toFixed(1) : "-", tip: "RSI 14|Momentum oscillator measured on the latest bars.|High RSI can mean strength or overextension; low RSI can mean weakness or opportunity." },
  { key: "supportGap", label: "Support", higherBetter: false, format: formatPct, tip: "Distance to Support|How far price sits above the nearest local support level.|Smaller distance can mean tighter risk if the support is valid." },
  { key: "resistanceGap", label: "Resist.", higherBetter: true, format: formatPct, tip: "Distance to Resistance|How much room price has to the nearest local resistance.|More room can mean cleaner upside before the next likely reaction zone." },
];

function getNearestLevels(analysis, current) {
  const levels = Array.isArray(analysis?.sr) ? analysis.sr : [];
  const supports = levels.filter((level) => level.price < current).sort((a, b) => b.price - a.price);
  const resistances = levels.filter((level) => level.price >= current).sort((a, b) => a.price - b.price);
  return {
    support: supports[0] || null,
    resistance: resistances[0] || null,
  };
}

function buildCompareRows() {
  const spyBars = state.data.SPY?.bars || [];
  const spy3m = computeReturn(spyBars, 63);
  return state.tickers.map((symbol) => {
    const data = state.data[symbol] || null;
    const analysis = state.analysis[symbol] || null;
    const bars = data?.bars || [];
    const current = Number(data?.latestClose);
    const levels = getNearestLevels(analysis, current);
    const return1m = computeReturn(bars, 21);
    const return3m = computeReturn(bars, 63);
    const supportGap = levels.support && Number.isFinite(current) ? ((current - levels.support.price) / current) * 100 : NaN;
    const resistanceGap = levels.resistance && Number.isFinite(current) ? ((levels.resistance.price - current) / current) * 100 : NaN;
    const fundamentals = state.fundamentals[symbol] || {};
    const targetMeanPrice = Number(fundamentals.targetMeanPrice);
    const targetBasePrice = Number.isFinite(current) ? current : Number(fundamentals.currentPrice);
    return {
      symbol,
      price: current,
      changePct: Number(data?.changePct),
      marketCap: Number(fundamentals.marketCap),
      trailingPE: Number(fundamentals.trailingPE),
      forwardPE: Number(fundamentals.forwardPE),
      pegRatio: Number(fundamentals.pegRatio),
      priceToBook: Number(fundamentals.priceToBook),
      trailingEps: Number(fundamentals.trailingEps),
      forwardEps: Number(fundamentals.forwardEps),
      dividendYieldPct: Number(fundamentals.dividendYieldPct),
      beta: Number(fundamentals.beta),
      targetMeanPrice,
      targetUpsidePct: Number.isFinite(targetMeanPrice) && Number.isFinite(targetBasePrice) && targetBasePrice > 0
        ? ((targetMeanPrice - targetBasePrice) / targetBasePrice) * 100
        : NaN,
      revenueGrowthPct: Number(fundamentals.revenueGrowthPct),
      earningsGrowthPct: Number(fundamentals.earningsGrowthPct),
      returnOnEquityPct: Number(fundamentals.returnOnEquityPct),
      profitMarginPct: Number(fundamentals.profitMarginPct),
      fundamentalsSource: fundamentals.source || "",
      fundamentalsWarning: fundamentals.warning || "",
      waveScore: Number(analysis?.confidence),
      wave: analysis?.wave ? `${analysis.wave.pattern} ${analysis.wave.currentWave}` : "No count",
      rsi: Number(analysis?.latestRsi),
      return1m,
      return3m,
      rs3m: Number.isFinite(return3m) && Number.isFinite(spy3m) ? return3m - spy3m : NaN,
      supportGap,
      resistanceGap,
      source: data?.source || "",
    };
  });
}

function metricTone(value, metric) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "neutral";
  if (metric?.higherBetter === false) return n <= 0 ? "neutral" : "neutral";
  return n >= 0 ? "up" : "down";
}

function compareSortValue(row, metric) {
  const value = Number(row?.[metric?.key]);
  return Number.isFinite(value) ? value : (metric?.higherBetter ? -Infinity : Infinity);
}

function setPanelHtml(html) {
  refs.panel.innerHTML = html;
  hydrateTooltips();
}

function renderPanel() {
  const data = state.data[state.selected];
  const analysis = state.analysis[state.selected];
  if (!data || !analysis) {
    setPanelHtml(`<div class="card"><h3>No data</h3><p class="muted">Load a ticker first.</p></div>`);
    return;
  }
  const wave = analysis.wave;
  if (state.tab === "scanner") {
    setPanelHtml(`
      <div class="card">
        <h3>Wave scanner</h3>
        <div class="scanner-list">
          ${sortedTickers().map((symbol) => {
            const item = state.analysis[symbol];
            const d = state.data[symbol];
            return `
              <div class="scanner-item">
                <strong>${symbol}</strong>
                <div>
                  <div>${item?.wave ? `${item.wave.pattern} · ${item.wave.currentWave}` : "No count"}</div>
                  <div class="small">${d ? `${formatPct(d.changePct)} · RSI ${item?.latestRsi?.toFixed(1) || "-"}` : "not loaded"}</div>
                </div>
                <span class="pill">${item?.confidence || 0}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `);
    return;
  }
  if (state.tab === "risk") {
    const nearestSupport = analysis.sr.filter((level) => level.role === "support").at(-1) || analysis.sr.find((level) => level.role === "support");
    const nearestResistance = analysis.sr.find((level) => level.role === "resistance");
    const current = data.latestClose;
    setPanelHtml(`
      <div class="card">
        <h3>Risk map</h3>
        <div class="metric-grid">
          <div class="metric"><span>Nearest support</span><strong>${nearestSupport ? formatPrice(nearestSupport.price) : "-"}</strong></div>
          <div class="metric"><span>Nearest resistance</span><strong>${nearestResistance ? formatPrice(nearestResistance.price) : "-"}</strong></div>
          <div class="metric"><span>Downside to support</span><strong>${nearestSupport ? formatPct(((nearestSupport.price - current) / current) * 100) : "-"}</strong></div>
          <div class="metric"><span>Upside to resistance</span><strong>${nearestResistance ? formatPct(((nearestResistance.price - current) / current) * 100) : "-"}</strong></div>
        </div>
      </div>
      <div class="card">
        <h3>RSI divergence</h3>
        <p class="${analysis.divergence?.type === "bullish" ? "up" : analysis.divergence?.type === "bearish" ? "down" : "muted"}">
          ${analysis.divergence ? `${analysis.divergence.type.toUpperCase()} divergence detected` : "No current divergence in the last lookback window."}
        </p>
      </div>
    `);
    return;
  }
  if (state.tab === "rs") {
    const spyBars = state.data.SPY?.bars || [];
    const spy1m = computeReturn(spyBars, 21);
    const spy3m = computeReturn(spyBars, 63);
    setPanelHtml(`
      <div class="card">
        <h3>Relative strength vs SPY</h3>
        <div class="scanner-list">
          ${sortedTickers().map((symbol) => {
            const bars = state.data[symbol]?.bars || [];
            const r1 = computeReturn(bars, 21);
            const r3 = computeReturn(bars, 63);
            const rs = Number.isFinite(r3) && Number.isFinite(spy3m) ? r3 - spy3m : NaN;
            const tone = Number.isFinite(rs) ? (rs > 5 ? "up" : rs < -5 ? "down" : "neutral") : "muted";
            return `
              <div class="scanner-item" data-symbol="${escapeHtml(symbol)}">
                <strong>${escapeHtml(symbol)}</strong>
                <div>
                  <div class="${tone}">${Number.isFinite(rs) ? `${rs >= 0 ? "+" : ""}${rs.toFixed(1)} pts vs SPY` : "Need data"}</div>
                  <div class="small">1M ${Number.isFinite(r1) ? formatPct(r1) : "-"} · 3M ${Number.isFinite(r3) ? formatPct(r3) : "-"} · SPY 3M ${Number.isFinite(spy3m) ? formatPct(spy3m) : "-"}</div>
                </div>
                <span class="pill">${Number.isFinite(r3) ? formatPct(r3) : "-"}</span>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `);
    return;
  }
  if (state.tab === "compare") {
    ensureCompareFundamentals();
    const activeMetric = COMPARE_METRICS.find((metric) => metric.key === state.compareMetric) || COMPARE_METRICS[0];
    const rows = buildCompareRows().sort((left, right) => {
      const diff = compareSortValue(right, activeMetric) - compareSortValue(left, activeMetric);
      return activeMetric.higherBetter ? diff : -diff;
    });
    const fundamentalsPending = state.tickers.some((symbol) => fundamentalsLoading.has(symbol));
    setPanelHtml(`
      <div class="card">
        <h3>Compare watchlist</h3>
        <p class="small">Sort by technicals, valuation, payout, and growth metrics. Fundamentals are cached locally by the app server.</p>
        <div class="compare-metric-bar">
          ${COMPARE_METRICS.map((metric) => `
            <button
              type="button"
              class="${metric.key === activeMetric.key ? "active" : ""}"
              data-compare-metric="${metric.key}"
              data-tip="${escapeHtml(metric.tip || metric.label)}"
            >
              ${escapeHtml(metric.label)}
            </button>
          `).join("")}
        </div>
        ${fundamentalsPending ? `<p class="small">Loading fundamentals for the watchlist...</p>` : ""}
        <div class="compare-table-wrap">
          <table class="compare-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>${escapeHtml(activeMetric.label)}</th>
                <th>Price</th>
                <th>1D</th>
                <th>P/E</th>
                <th>Fwd P/E</th>
                <th>PEG</th>
                <th>EPS</th>
                <th>Fwd EPS</th>
                <th>Yield</th>
                <th>Target</th>
                <th>Rev Gr.</th>
                <th>ROE</th>
                <th>Wave</th>
                <th>RSI</th>
                <th>1M</th>
                <th>3M</th>
                <th>Support</th>
                <th>Resist.</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => {
                const activeValue = activeMetric.format(row[activeMetric.key]);
                const activeTone = metricTone(row[activeMetric.key], activeMetric);
                return `
                  <tr data-symbol="${escapeHtml(row.symbol)}">
                    <td><strong>${escapeHtml(row.symbol)}</strong></td>
                    <td class="${activeTone}">${escapeHtml(activeValue)}</td>
                    <td>${formatPrice(row.price)}</td>
                    <td class="${row.changePct >= 0 ? "up" : "down"}">${formatPct(row.changePct)}</td>
                    <td>${formatRatio(row.trailingPE)}</td>
                    <td>${formatRatio(row.forwardPE)}</td>
                    <td>${formatRatio(row.pegRatio)}</td>
                    <td>${formatPrice(row.trailingEps)}</td>
                    <td>${formatPrice(row.forwardEps)}</td>
                    <td>${formatUnsignedPct(row.dividendYieldPct)}</td>
                    <td class="${row.targetUpsidePct >= 0 ? "up" : "down"}">${formatPct(row.targetUpsidePct)}</td>
                    <td class="${row.revenueGrowthPct >= 0 ? "up" : "down"}">${formatPct(row.revenueGrowthPct)}</td>
                    <td>${formatUnsignedPct(row.returnOnEquityPct)}</td>
                    <td>${escapeHtml(row.wave)}</td>
                    <td>${Number.isFinite(row.rsi) ? row.rsi.toFixed(1) : "-"}</td>
                    <td class="${row.return1m >= 0 ? "up" : "down"}">${formatPct(row.return1m)}</td>
                    <td class="${row.return3m >= 0 ? "up" : "down"}">${formatPct(row.return3m)}</td>
                    <td>${Number.isFinite(row.supportGap) ? formatPct(-row.supportGap) : "-"}</td>
                    <td>${Number.isFinite(row.resistanceGap) ? formatPct(row.resistanceGap) : "-"}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `);
    return;
  }
  if (state.tab === "portfolio") {
    const rows = state.positions.map((position) => {
      const current = state.data[position.symbol]?.latestClose;
      const value = Number.isFinite(current) ? current * position.shares : NaN;
      const cost = position.entry * position.shares;
      const pnl = Number.isFinite(value) ? value - cost : NaN;
      return { ...position, current, value, cost, pnl };
    });
    const totalCost = rows.reduce((sum, row) => sum + (Number.isFinite(row.cost) ? row.cost : 0), 0);
    const totalValue = rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
    setPanelHtml(`
      <div class="card">
        <h3>Position tracker</h3>
        <form id="portfolioForm" class="portfolio-form">
          <input name="symbol" placeholder="Ticker" value="${escapeHtml(state.selected)}" />
          <input name="shares" type="number" step="any" min="0" placeholder="Shares" />
          <input name="entry" type="number" step="any" min="0" placeholder="Entry" />
          <select name="wave">
            <option>Wave I</option>
            <option>Wave II</option>
            <option>Wave III</option>
            <option>Wave IV</option>
            <option>Wave V</option>
            <option>ABC</option>
          </select>
          <button type="submit">Add</button>
        </form>
      </div>
      <div class="card">
        <h3>Open positions</h3>
        <div class="metric-grid">
          <div class="metric"><span>Total cost</span><strong>${formatPrice(totalCost)}</strong></div>
          <div class="metric"><span>Total P&L</span><strong class="${totalValue - totalCost >= 0 ? "up" : "down"}">${Number.isFinite(totalValue) ? formatPrice(totalValue - totalCost) : "-"}</strong></div>
        </div>
        <div class="portfolio-list">
          ${rows.length ? rows.map((row, index) => `
            <div class="portfolio-row">
              <div>
                <strong>${escapeHtml(row.symbol)}</strong>
                <div class="small">${escapeHtml(row.wave)} · ${row.shares} @ ${formatPrice(row.entry)}</div>
              </div>
              <div class="${Number.isFinite(row.pnl) && row.pnl >= 0 ? "up" : "down"}">${Number.isFinite(row.pnl) ? formatPrice(row.pnl) : "-"}</div>
              <button type="button" data-delete-position="${index}" class="ghost">Delete</button>
            </div>
          `).join("") : `<p class="muted">No positions yet.</p>`}
        </div>
      </div>
    `);
    return;
  }
  if (state.tab === "help") {
    setPanelHtml(`
      <div class="card">
        <h3>Keyboard shortcuts</h3>
        <div class="rules">
          <div class="rule-row"><span>1-9</span><strong>Jump watchlist</strong></div>
          <div class="rule-row"><span>← / →</span><strong>Timeframe</strong></div>
          <div class="rule-row"><span>W F R Z V</span><strong>Toggle core overlays</strong></div>
          <div class="rule-row"><span>C M P T</span><strong>Channel, measured move, profile, fib time</strong></div>
          <div class="rule-row"><span>S</span><strong>Open scanner</strong></div>
          <div class="rule-row"><span>?</span><strong>Open this help</strong></div>
        </div>
      </div>
      <div class="card">
        <h3>Added from Wavefront</h3>
        <p class="small">WMA200, volume profile, regression channel, measured move projections, Fibonacci time zones, candlestick pattern labels, RS ranking, portfolio tracking, and keyboard navigation.</p>
      </div>
    `);
    return;
  }
  setPanelHtml(`
    <div class="card">
      <h3>${data.symbol} · ${data.label}</h3>
      <div class="metric-grid">
        <div class="metric"><span>Latest close</span><strong>${formatPrice(data.latestClose)}</strong></div>
        <div class="metric"><span>Daily change</span><strong class="${data.changePct >= 0 ? "up" : "down"}">${formatPct(data.changePct)}</strong></div>
        <div class="metric"><span>Wave score</span><strong>${analysis.confidence}</strong></div>
        <div class="metric"><span>RSI 14</span><strong>${analysis.latestRsi ? analysis.latestRsi.toFixed(1) : "-"}</strong></div>
      </div>
      <p class="small">Source: ${data.source}${data.warning ? ` · ${data.warning}` : ""}</p>
    </div>
    <div class="card">
      <h3>Wave count</h3>
      ${wave ? `
        <div class="metric-row"><span>Pattern</span><strong>${wave.pattern}</strong></div>
        <div class="metric-row"><span>Direction</span><strong class="${wave.direction === "up" ? "up" : "down"}">${wave.direction}</strong></div>
        <div class="metric-row"><span>Current wave</span><strong>${wave.currentWave}</strong></div>
        <div class="rules">
          ${wave.rules.map((rule) => `<div class="rule-row"><span>${rule.text}</span><span class="pill ${rule.ok ? "up" : "down"}">${rule.ok ? "OK" : "WARN"}</span></div>`).join("")}
        </div>
      ` : `<p class="muted">No clean Elliott count found yet. Try another range or ticker.</p>`}
    </div>
    <div class="card">
      <h3>Targets</h3>
      ${analysis.forecast ? `
        <div class="metric-row"><span>0.618 target</span><strong>${formatPrice(analysis.forecast.target618)}</strong></div>
        <div class="metric-row"><span>1.000 target</span><strong>${formatPrice(analysis.forecast.target100)}</strong></div>
        <div class="metric-row"><span>1.618 target</span><strong>${formatPrice(analysis.forecast.target1618)}</strong></div>
        <div class="metric-row"><span>Invalidation / stop</span><strong>${formatPrice(analysis.forecast.stop)}</strong></div>
      ` : `<p class="muted">Targets need a valid wave count.</p>`}
    </div>
  `);
}

function visibleBars() {
  const bars = state.data[state.selected]?.bars || [];
  if (!state.zoom) return bars;
  return bars.slice(state.zoom.start, state.zoom.end + 1);
}

function resizeCanvas() {
  const rect = refs.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  refs.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  refs.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawForecastLine(chartLeft, chartRight, y, color, label) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([9, 5]);
  ctx.beginPath();
  ctx.moveTo(chartLeft, y);
  ctx.lineTo(chartRight, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  const textW = ctx.measureText(label).width + 12;
  drawRoundRect(chartLeft + 8, y - 10, textW, 18, 5);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, chartLeft + 14, y + 4);
}

function drawChart() {
  const width = refs.canvas.clientWidth;
  const height = refs.canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  const bars = visibleBars();
  const analysis = state.analysis[state.selected];
  refs.empty.style.display = bars.length ? "none" : "grid";
  if (!bars.length) return;

  const pad = { left: 48, right: 72, top: 22, bottom: state.overlays.volume ? 92 : 38 };
  const chartLeft = pad.left;
  const chartRight = width - pad.right;
  const chartTop = pad.top;
  const chartBottom = height - pad.bottom;
  const chartW = Math.max(40, chartRight - chartLeft);
  const chartH = Math.max(40, chartBottom - chartTop);
  const fibOverlay = state.overlays.fibs ? getVisibleFibOverlay(bars, analysis) : null;
  const measuredMove = state.overlays.measured ? measuredMoveTargets(analysis?.wave, bars) : null;
  const minCandidates = bars.map((bar) => bar.l);
  const maxCandidates = bars.map((bar) => bar.h);
  if (fibOverlay?.levels?.length) {
    fibOverlay.levels.forEach((fib) => {
      if (Number.isFinite(fib.price)) {
        minCandidates.push(fib.price);
        maxCandidates.push(fib.price);
      }
    });
  }
  if (measuredMove?.targets?.length) {
    measuredMove.targets.forEach((target) => {
      if (Number.isFinite(target.price)) {
        minCandidates.push(target.price);
        maxCandidates.push(target.price);
      }
    });
  }
  if (analysis?.forecast) {
    ["target618", "target100", "target1618", "stop", "buyLow", "buyHigh"].forEach((key) => {
      const price = analysis.forecast[key];
      if (Number.isFinite(price)) {
        minCandidates.push(price);
        maxCandidates.push(price);
      }
    });
  }
  const min = Math.min(...minCandidates);
  const max = Math.max(...maxCandidates);
  const span = max - min || 1;
  const minP = Math.max(0, min - span * 0.08);
  const maxP = max + span * 0.12;
  const px = (index) => chartLeft + (index / Math.max(1, bars.length - 1)) * chartW;
  const py = (price) => chartBottom - ((price - minP) / (maxP - minP)) * chartH;

  ctx.strokeStyle = "rgba(126,141,160,0.16)";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#7e8da0";
  for (let i = 0; i <= 5; i += 1) {
    const y = chartTop + (i / 5) * chartH;
    const price = maxP - (i / 5) * (maxP - minP);
    ctx.beginPath();
    ctx.moveTo(chartLeft, y);
    ctx.lineTo(chartRight, y);
    ctx.stroke();
    ctx.fillText(formatPrice(price), chartRight + 8, y + 4);
  }

  if (state.overlays.profile) {
    const buckets = 20;
    const profile = Array.from({ length: buckets }, (_, index) => ({
      index,
      volume: 0,
      price: minP + ((index + 0.5) / buckets) * (maxP - minP),
    }));
    bars.forEach((bar) => {
      const mid = (bar.h + bar.l + bar.c) / 3;
      const bucket = Math.max(0, Math.min(buckets - 1, Math.floor(((mid - minP) / (maxP - minP)) * buckets)));
      profile[bucket].volume += bar.v || 0;
    });
    const maxProfileVolume = Math.max(...profile.map((bucket) => bucket.volume), 1);
    profile.forEach((bucket) => {
      const y = py(bucket.price);
      const w = (bucket.volume / maxProfileVolume) * Math.min(110, chartW * 0.22);
      ctx.fillStyle = "rgba(15, 23, 42, 0.1)";
      ctx.fillRect(chartLeft, y - chartH / buckets / 2, w, Math.max(2, chartH / buckets - 2));
    });
    const poc = profile.reduce((best, bucket) => bucket.volume > best.volume ? bucket : best, profile[0]);
    ctx.strokeStyle = "rgba(217,119,6,0.8)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(chartLeft, py(poc.price));
    ctx.lineTo(chartRight, py(poc.price));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.overlays.channel) {
    const channel = regressionChannel(bars);
    if (channel) {
      [
        { fn: channel.upper, color: "rgba(239,68,68,0.58)" },
        { fn: channel.center, color: "rgba(37,99,235,0.74)" },
        { fn: channel.lower, color: "rgba(22,163,74,0.58)" },
      ].forEach((line) => {
        ctx.strokeStyle = line.color;
        ctx.lineWidth = line.fn === channel.center ? 1.8 : 1.2;
        ctx.setLineDash(line.fn === channel.center ? [] : [6, 5]);
        ctx.beginPath();
        bars.forEach((_, index) => {
          const x = px(index);
          const y = py(line.fn(index));
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
  }

  if (state.overlays.zones && analysis?.forecast?.buyLow && analysis?.forecast?.buyHigh) {
    const y1 = py(analysis.forecast.buyLow);
    const y2 = py(analysis.forecast.buyHigh);
    ctx.fillStyle = "rgba(33,200,117,0.09)";
    ctx.fillRect(chartLeft, Math.min(y1, y2), chartW, Math.abs(y2 - y1));
  }

  if (analysis?.forecast) {
    const forecastLines = [
      { key: "target618", color: "rgba(37,99,235,0.88)", label: "Forecast 0.618" },
      { key: "target100", color: "rgba(79,70,229,0.88)", label: "Forecast 1.0" },
      { key: "target1618", color: "rgba(14,165,233,0.9)", label: "Forecast 1.618" },
      { key: "stop", color: "rgba(239,68,68,0.88)", label: "Forecast stop" },
    ];
    forecastLines.forEach((line) => {
      const price = analysis.forecast[line.key];
      if (!Number.isFinite(price)) return;
      const y = py(price);
      if (y < chartTop || y > chartBottom) return;
      drawForecastLine(chartLeft, chartRight, y, line.color, `${line.label} ${formatPrice(price)}`);
    });
  }

  if (state.overlays.sr && analysis?.sr) {
    analysis.sr.forEach((level) => {
      const y = py(level.price);
      if (y < chartTop || y > chartBottom) return;
      const color = level.role === "support" ? "#21c875" : "#ef476f";
      ctx.setLineDash([8, 5]);
      ctx.strokeStyle = `${color}99`;
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(`${level.role[0].toUpperCase()}${level.touches} ${formatPrice(level.price)}`, chartRight - 58, y - 4);
    });
  }

  const barW = Math.max(2, chartW / bars.length);
  bars.forEach((bar, index) => {
    const x = px(index);
    const up = bar.c >= bar.o;
    const color = up ? "#21c875" : "#ef476f";
    ctx.strokeStyle = `${color}cc`;
    ctx.beginPath();
    ctx.moveTo(x, py(bar.h));
    ctx.lineTo(x, py(bar.l));
    ctx.stroke();
    const bodyTop = py(Math.max(bar.o, bar.c));
    const bodyBottom = py(Math.min(bar.o, bar.c));
    ctx.fillStyle = `${color}bb`;
    ctx.fillRect(x - Math.min(7, barW * 0.34), bodyTop, Math.max(1, Math.min(14, barW * 0.68)), Math.max(1, bodyBottom - bodyTop));
  });

  ctx.strokeStyle = "#8cb7ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  bars.forEach((bar, index) => {
    const x = px(index);
    const y = py(bar.c);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (state.overlays.wma50) {
    const fullBars = state.data[state.selected]?.bars || bars;
    const wma = calcWMAValues(fullBars, 50);
    const visibleStart = fullBars.findIndex((bar) => bar.date.getTime() === bars[0].date.getTime());
    ctx.strokeStyle = "rgba(249,115,22,0.95)";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let started = false;
    bars.forEach((bar, index) => {
      const fullIndex = visibleStart >= 0 ? visibleStart + index : fullBars.findIndex((item) => item.date.getTime() === bar.date.getTime());
      const value = wma[fullIndex];
      if (!Number.isFinite(value)) return;
      const x = px(index);
      const y = py(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.overlays.wma200) {
    const fullBars = state.data[state.selected]?.bars || bars;
    const wma = calcWMAValues(fullBars, 200);
    const visibleStart = fullBars.findIndex((bar) => bar.date.getTime() === bars[0].date.getTime());
    ctx.strokeStyle = "rgba(14,165,233,0.92)";
    ctx.lineWidth = 1.8;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    let started = false;
    bars.forEach((bar, index) => {
      const fullIndex = visibleStart >= 0 ? visibleStart + index : fullBars.findIndex((item) => item.date.getTime() === bar.date.getTime());
      const value = wma[fullIndex];
      if (!Number.isFinite(value)) return;
      const x = px(index);
      const y = py(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    if (started) ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.overlays.fibs) {
    const visibleLevels = fibOverlay.levels.filter((fib) => {
      const y = py(fib.price);
      return y >= chartTop && y <= chartBottom;
    });
    visibleLevels.forEach((fib) => {
      const y = py(fib.price);
      const isKey = fib.ratio === 0.382 || fib.ratio === 0.5 || fib.ratio === 0.618 || fib.ratio === 1;
      const color = fib.extension ? "#0ea5e9" : "#7c3aed";
      if (isKey) {
        ctx.fillStyle = fib.ratio === 0.618 ? "rgba(124,58,237,0.08)" : "rgba(124,58,237,0.045)";
        ctx.fillRect(chartLeft, y - 7, chartW, 14);
      }
      ctx.setLineDash(fib.extension ? [7, 5] : [5, 4]);
      ctx.strokeStyle = fib.extension ? "rgba(14,165,233,0.82)" : "rgba(124,58,237,0.78)";
      ctx.lineWidth = isKey ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      const sourceLabel = fibOverlay.source === "live" ? "Live" : fibOverlay.source === "wave" ? "Wave" : "Range";
      const label = `${sourceLabel} ${fib.label}`;
      const price = formatPrice(fib.price);
      ctx.font = `${isKey ? "700 " : ""}11px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const labelW = ctx.measureText(label).width + 12;
      const priceW = ctx.measureText(price).width + 12;
      ctx.fillStyle = color;
      drawRoundRect(chartLeft + 6, y - 10, labelW, 18, 5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, chartLeft + 12, y + 4);
      ctx.fillStyle = color;
      drawRoundRect(chartRight - priceW - 6, y - 10, priceW, 18, 5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(price, chartRight - priceW, y + 4);
    });
  }

  if (state.overlays.measured) {
    const mm = measuredMove;
    if (mm) {
      mm.targets.forEach((target) => {
        const y = py(target.price);
        if (y < chartTop || y > chartBottom) return;
        ctx.strokeStyle = "rgba(217,119,6,0.82)";
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        ctx.moveTo(chartLeft, y);
        ctx.lineTo(chartRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#d97706";
        ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(`${target.label} ${formatPrice(target.price)}`, chartLeft + 8, y - 5);
      });
    }
  }

  if (state.overlays.fibtime) {
    const pivot = analysis?.wave?.pivots?.at(-1);
    if (pivot) {
      let pivotIndex = bars.findIndex((bar) => bar.date.getTime() === pivot.date.getTime());
      if (pivotIndex < 0) pivotIndex = Math.max(0, bars.length - 1);
      [1, 2, 3, 5, 8, 13, 21, 34].forEach((step) => {
        const index = pivotIndex + step;
        if (index >= bars.length) return;
        const x = px(index);
        ctx.strokeStyle = "rgba(124,58,237,0.35)";
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(x, chartTop);
        ctx.lineTo(x, chartBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#7c3aed";
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(`T${step}`, x + 3, chartTop + 12);
      });
    }
  }

  if (state.overlays.waves && analysis?.wave) {
    const firstDate = bars[0].date.getTime();
    const lastDate = bars[bars.length - 1].date.getTime();
    const pivots = analysis.wave.pivots.filter((pivot) => {
      const time = pivot.date.getTime();
      return time >= firstDate && time <= lastDate;
    });
    const mapped = pivots.map((pivot) => {
      let best = 0;
      let diff = Infinity;
      bars.forEach((bar, index) => {
        const d = Math.abs(bar.date - pivot.date);
        if (d < diff) {
          diff = d;
          best = index;
        }
      });
      return { ...pivot, x: px(best), y: py(pivot.price) };
    });
    ctx.lineWidth = 2;
    for (let i = 1; i < mapped.length; i += 1) {
      ctx.strokeStyle = `${mapped[i].color || "#4f8cff"}dd`;
      ctx.beginPath();
      ctx.moveTo(mapped[i - 1].x, mapped[i - 1].y);
      ctx.lineTo(mapped[i].x, mapped[i].y);
      ctx.stroke();
    }
    mapped.forEach((pivot) => {
      ctx.fillStyle = pivot.color || "#4f8cff";
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pivot.color || "#4f8cff";
      ctx.font = "700 13px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(pivot.label, pivot.x, pivot.type === "H" ? pivot.y - 12 : pivot.y + 22);
    });
    ctx.textAlign = "left";
  }

  if (state.overlays.divergence && analysis?.divergence) {
    const div = analysis.divergence;
    if (div.a < bars.length && div.b < bars.length) {
      const bullish = div.type === "bullish";
      const color = bullish ? "#21c875" : "#ef476f";
      const y1 = py(bullish ? bars[div.a].l : bars[div.a].h);
      const y2 = py(bullish ? bars[div.b].l : bars[div.b].h);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(div.a), y1);
      ctx.lineTo(px(div.b), y2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(bullish ? "BULL DIV" : "BEAR DIV", px(div.b) - 24, bullish ? y2 + 22 : y2 - 12);
    }
  }

  if (state.overlays.candles) {
    detectCandlePatterns(bars).forEach((pattern) => {
      const bar = bars[pattern.index];
      if (!bar) return;
      const bullish = pattern.tone === "bullish";
      const bearish = pattern.tone === "bearish";
      const color = bullish ? "#16a34a" : bearish ? "#ef4444" : "#64748b";
      const x = px(pattern.index);
      const y = bullish ? py(bar.l) + 18 : py(bar.h) - 14;
      ctx.font = "700 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(pattern.label).width + 10;
      ctx.fillStyle = color;
      drawRoundRect(x - tw / 2, y - 10, tw, 16, 5);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText(pattern.label, x, y + 2);
      ctx.textAlign = "left";
    });
  }

  const current = bars[bars.length - 1].c;
  const currentY = py(current);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "rgba(140,183,255,0.75)";
  ctx.beginPath();
  ctx.moveTo(chartLeft, currentY);
  ctx.lineTo(chartRight, currentY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#8cb7ff";
  drawRoundRect(chartRight + 6, currentY - 10, 60, 20, 4);
  ctx.fill();
  ctx.fillStyle = "#081018";
  ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(formatPrice(current), chartRight + 36, currentY + 4);
  ctx.textAlign = "left";

  const maxVol = Math.max(...bars.map((bar) => bar.v || 0));
  if (state.overlays.volume && maxVol > 0) {
    const volTop = chartBottom + 18;
    const volH = height - volTop - 24;
    bars.forEach((bar, index) => {
      const x = px(index);
      const h = (bar.v / maxVol) * volH;
      ctx.fillStyle = bar.c >= bar.o ? "rgba(33,200,117,0.38)" : "rgba(239,71,111,0.38)";
      ctx.fillRect(x - Math.max(1, barW * 0.32), volTop + volH - h, Math.max(1, barW * 0.64), h);
    });
  }

  if (state.crosshair) {
    const { x, y } = state.crosshair;
    if (x >= chartLeft && x <= chartRight && y >= chartTop && y <= chartBottom) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(232,238,245,0.34)";
      ctx.beginPath();
      ctx.moveTo(x, chartTop);
      ctx.lineTo(x, chartBottom);
      ctx.moveTo(chartLeft, y);
      ctx.lineTo(chartRight, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const idx = Math.max(0, Math.min(bars.length - 1, Math.round(((x - chartLeft) / chartW) * (bars.length - 1))));
      const bar = bars[idx];
      const label = `${bar.date.toISOString().slice(0, 10)} O ${formatPrice(bar.o)} H ${formatPrice(bar.h)} L ${formatPrice(bar.l)} C ${formatPrice(bar.c)}`;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = "rgba(13,19,26,0.95)";
      drawRoundRect(Math.min(width - tw - 12, Math.max(8, x - tw / 2)), chartTop + 6, tw, 24, 4);
      ctx.fill();
      ctx.fillStyle = "#e8eef5";
      ctx.fillText(label, Math.min(width - tw - 12, Math.max(8, x - tw / 2)) + 7, chartTop + 22);
    }
  }
}

async function selectSymbol(symbol) {
  state.selected = symbol;
  state.zoom = null;
  saveState();
  if (!state.data[symbol]) await fetchTicker(symbol);
  renderAll();
}

async function addSymbol(value) {
  const symbol = normalizeSymbol(value);
  if (!symbol) return;
  if (!state.tickers.includes(symbol)) state.tickers.push(symbol);
  refs.input.value = "";
  await selectSymbol(symbol);
}

function renderAll() {
  renderWatchlist();
  renderPanel();
  drawChart();
}

function setOverlay(key, force = null) {
  if (!(key in state.overlays)) return;
  state.overlays[key] = force == null ? !state.overlays[key] : !!force;
  refs.overlays.querySelector(`[data-toggle="${key}"]`)?.classList.toggle("active", state.overlays[key]);
  saveState();
  setStatus(`${key.toUpperCase()} ${state.overlays[key] ? "shown" : "hidden"}`);
  drawChart();
}

function stepTimeframe(direction) {
  const buttons = [...refs.timeframes.querySelectorAll("[data-range]")];
  const currentIndex = Math.max(0, buttons.findIndex((button) => button.dataset.range === state.range));
  const next = buttons[Math.max(0, Math.min(buttons.length - 1, currentIndex + direction))];
  next?.click();
}

function hydrateTooltips() {
  document.querySelectorAll("[data-tip]").forEach((element) => {
    element.dataset.tip = String(element.dataset.tip || "").replace(/\|/g, "\n");
  });
}

function ensureTooltipEl() {
  if (tooltipState.el) return tooltipState.el;
  const el = document.createElement("div");
  el.className = "hover-tip";
  el.hidden = true;
  document.body.appendChild(el);
  tooltipState.el = el;
  return el;
}

function placeTooltip(target) {
  const el = ensureTooltipEl();
  const rect = target.getBoundingClientRect();
  const margin = 10;
  const gap = 10;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const showAbove = rect.top >= height + gap + margin;
  const top = showAbove ? rect.top - height - gap : rect.bottom + gap;
  el.dataset.side = showAbove ? "top" : "bottom";
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(margin, Math.min(top, window.innerHeight - height - margin)))}px`;
}

function showTooltip(target) {
  const text = String(target?.dataset.tip || "").trim();
  if (!text) return;
  const el = ensureTooltipEl();
  tooltipState.target = target;
  tooltipState.text = text;
  el.textContent = text;
  el.hidden = false;
  placeTooltip(target);
  requestAnimationFrame(() => el.classList.add("visible"));
}

function hideTooltip() {
  clearTimeout(tooltipState.timer);
  tooltipState.timer = null;
  tooltipState.target = null;
  const el = tooltipState.el;
  if (!el) return;
  el.classList.remove("visible");
  window.setTimeout(() => {
    if (!el.classList.contains("visible")) el.hidden = true;
  }, 160);
}

function scheduleTooltip(target) {
  clearTimeout(tooltipState.timer);
  hideTooltip();
  tooltipState.timer = window.setTimeout(() => {
    tooltipState.timer = null;
    showTooltip(target);
  }, 650);
}

function wireTooltips() {
  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-tip]");
    if (!target) return;
    if (tooltipState.target === target) return;
    scheduleTooltip(target);
  });
  document.addEventListener("mouseout", (event) => {
    const from = event.target.closest("[data-tip]");
    if (!from) return;
    const related = event.relatedTarget?.closest?.("[data-tip]") || null;
    if (related === from) return;
    hideTooltip();
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) scheduleTooltip(target);
  });
  document.addEventListener("focusout", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) hideTooltip();
  });
  window.addEventListener("scroll", () => {
    if (tooltipState.target && !tooltipState.el?.hidden) placeTooltip(tooltipState.target);
  }, true);
  window.addEventListener("resize", () => {
    if (tooltipState.target && !tooltipState.el?.hidden) placeTooltip(tooltipState.target);
  });
}

function wireEvents() {
  refs.form.addEventListener("submit", (event) => {
    event.preventDefault();
    addSymbol(refs.input.value).catch((error) => setStatus(error.message));
  });
  refs.watchlist.addEventListener("click", (event) => {
    const card = event.target.closest("[data-symbol]");
    if (card) selectSymbol(card.dataset.symbol).catch((error) => setStatus(error.message));
  });
  refs.sort.addEventListener("change", () => {
    state.sort = refs.sort.value;
    saveState();
    renderWatchlist();
  });
  refs.timeframes.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-range]");
    if (!button) return;
    state.range = button.dataset.range;
    state.zoom = null;
    refs.timeframes.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    saveState();
    state.data = {};
    state.analysis = {};
    await fetchTicker(state.selected).catch(() => null);
    renderAll();
    Promise.all(
      state.tickers
        .filter((symbol) => symbol !== state.selected)
        .map((symbol) => fetchTicker(symbol).catch(() => null))
    ).then(() => {
      renderWatchlist();
      if (state.tab === "scanner" || state.tab === "rs" || state.tab === "compare") renderPanel();
    });
    renderAll();
  });
  refs.overlays.addEventListener("click", (event) => {
    const button = event.target.closest("[data-toggle]");
    if (!button) return;
    setOverlay(button.dataset.toggle);
  });
  refs.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.tab = button.dataset.tab;
    refs.tabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    renderPanel();
  });
  refs.panel.addEventListener("click", (event) => {
    const metricButton = event.target.closest("[data-compare-metric]");
    if (metricButton) {
      state.compareMetric = metricButton.dataset.compareMetric;
      saveState();
      renderPanel();
      return;
    }
    const compareRow = event.target.closest(".compare-table tr[data-symbol]");
    if (compareRow) {
      selectSymbol(compareRow.dataset.symbol).catch((error) => setStatus(error.message));
      return;
    }
    const scannerItem = event.target.closest(".scanner-item[data-symbol]");
    if (scannerItem) {
      selectSymbol(scannerItem.dataset.symbol).catch((error) => setStatus(error.message));
      return;
    }
    const deleteButton = event.target.closest("[data-delete-position]");
    if (deleteButton) {
      state.positions.splice(Number(deleteButton.dataset.deletePosition), 1);
      saveState();
      renderPanel();
    }
  });
  refs.panel.addEventListener("submit", (event) => {
    if (event.target.id !== "portfolioForm") return;
    event.preventDefault();
    const form = new FormData(event.target);
    const symbol = normalizeSymbol(form.get("symbol"));
    const shares = Number(form.get("shares"));
    const entry = Number(form.get("entry"));
    if (!symbol || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(entry) || entry <= 0) {
      setStatus("Enter ticker, shares and entry price.");
      return;
    }
    state.positions.push({
      symbol,
      shares,
      entry,
      wave: String(form.get("wave") || "Wave"),
    });
    if (!state.tickers.includes(symbol)) state.tickers.push(symbol);
    saveState();
    fetchTicker(symbol).catch(() => null).finally(() => {
      renderAll();
      setStatus(`Position added: ${symbol}`);
    });
  });
  refs.resetZoom.addEventListener("click", () => {
    state.zoom = null;
    drawChart();
  });
  refs.canvas.addEventListener("dblclick", () => {
    state.zoom = null;
    setStatus("Zoom reset");
    drawChart();
  });
  refs.canvas.addEventListener("mousedown", (event) => {
    if (!state.zoom) return;
    panStart = { x: event.clientX, start: state.zoom.start, end: state.zoom.end };
  });
  refs.canvas.addEventListener("mousemove", (event) => {
    const rect = refs.canvas.getBoundingClientRect();
    state.crosshair = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (panStart) {
      const bars = state.data[state.selected]?.bars || [];
      const visibleCount = panStart.end - panStart.start + 1;
      const pxPerBar = Math.max(1, (rect.width - 120) / visibleCount);
      const shift = Math.round((panStart.x - event.clientX) / pxPerBar);
      let start = panStart.start + shift;
      let end = panStart.end + shift;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end >= bars.length) {
        start -= end - bars.length + 1;
        end = bars.length - 1;
      }
      state.zoom = { start: Math.max(0, start), end };
    }
    drawChart();
  });
  refs.canvas.addEventListener("mouseleave", () => {
    state.crosshair = null;
    panStart = null;
    drawChart();
  });
  window.addEventListener("mouseup", () => {
    panStart = null;
  });
  refs.canvas.addEventListener("wheel", (event) => {
    const bars = state.data[state.selected]?.bars || [];
    if (bars.length < 20) return;
    event.preventDefault();
    const current = state.zoom || { start: 0, end: bars.length - 1 };
    const count = current.end - current.start + 1;
    const direction = event.deltaY > 0 ? 1 : -1;
    const nextCount = Math.max(24, Math.min(bars.length, Math.round(count * (direction > 0 ? 1.12 : 0.88))));
    const rect = refs.canvas.getBoundingClientRect();
    const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left - 48) / Math.max(1, rect.width - 120)));
    const anchorIndex = current.start + anchor * (count - 1);
    let start = Math.round(anchorIndex - anchor * (nextCount - 1));
    let end = start + nextCount - 1;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end >= bars.length) {
      start -= end - bars.length + 1;
      end = bars.length - 1;
    }
    state.zoom = start <= 0 && end >= bars.length - 1 ? null : { start: Math.max(0, start), end };
    drawChart();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
    const key = String(event.key || "").toLowerCase();
    if (/^[1-9]$/.test(key)) {
      const symbol = sortedTickers()[Number(key) - 1];
      if (symbol) selectSymbol(symbol).catch((error) => setStatus(error.message));
      return;
    }
    if (key === "arrowleft") {
      event.preventDefault();
      stepTimeframe(-1);
      return;
    }
    if (key === "arrowright") {
      event.preventDefault();
      stepTimeframe(1);
      return;
    }
    const shortcutMap = {
      w: "waves",
      f: "fibs",
      r: "sr",
      z: "zones",
      v: "volume",
      d: "divergence",
      p: "profile",
      c: "channel",
      m: "measured",
      t: "fibtime",
      k: "candles",
    };
    if (shortcutMap[key]) {
      setOverlay(shortcutMap[key]);
      return;
    }
    if (key === "s") {
      state.tab = "scanner";
      refs.tabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.tab === "scanner"));
      renderPanel();
      return;
    }
    if (key === "?") {
      state.tab = "help";
      refs.tabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.tab === "help"));
      renderPanel();
      return;
    }
    if (key === "escape") {
      state.crosshair = null;
      panStart = null;
      drawChart();
    }
  });
  window.addEventListener("resize", resizeCanvas);
}

async function init() {
  loadState();
  hydrateTooltips();
  wireTooltips();
  refs.sort.value = state.sort;
  refs.timeframes.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.range === state.range));
  refs.overlays.querySelectorAll("button").forEach((button) => button.classList.toggle("active", !!state.overlays[button.dataset.toggle]));
  wireEvents();
  resizeCanvas();
  renderWatchlist();
  await Promise.all(state.tickers.map((symbol) => fetchTicker(symbol).catch((error) => {
    console.warn(error);
    return null;
  })));
  if (!state.tickers.includes(state.selected)) state.selected = state.tickers[0];
  renderAll();
}

init().catch((error) => setStatus(error.message));

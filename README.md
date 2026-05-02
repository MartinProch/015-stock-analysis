# Stock Analysis — Wavefront Lite

Stock Analysis is a local, single-page market dashboard built in this workspace as a lighter Codex version of the `014-wavefront` Elliott Wave terminal. It keeps the fast vanilla JavaScript/canvas architecture, but presents the workflow as a clean shadcn-style dashboard with a watchlist, chart workspace, analysis panels, and persistent local state.

The app is meant for fast visual stock review: load a ticker, scan its trend and wave structure, compare it against the watchlist, and keep a simple position log. It is not a trading system and should not be treated as financial advice.

## Current Status

- Local app served at `http://localhost:3460/`
- No build step required
- Vanilla HTML/CSS/JS frontend
- Node.js backend for static files and market data proxying
- Client state is saved in `localStorage`
- GitHub repo: `https://github.com/MartinProch/015-stock-analysis`

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3460/
```

The server uses `PORT=3460` by default. You can override it:

```bash
PORT=4000 npm start
```

## App Layout

The interface has three working regions:

- Left sidebar: watchlist and sorting.
- Center workspace: chart card with timeframe controls, overlay toggles, and canvas chart.
- Right sidebar: analysis tabs for waves, scanner, risk, relative strength, portfolio, and help.

The current design follows shadcn/dashboard conventions: light background, white cards, restrained borders, segmented controls, compact panels, and dense but readable information.

## Data Flow

The frontend calls:

```text
GET /api/chart?symbol=NVDA&range=2y
```

The backend first tries Yahoo Finance chart data:

```text
https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}
```

If Yahoo rate-limits or fails, the backend now falls back to Nasdaq’s public quote/chart endpoints. This replaced the old generated offline sample fallback, which could show plausible-looking but incorrect prices. The app now labels fallback data clearly in the source line and status text.

Important behavior:

- Yahoo data provides daily OHLCV history when available.
- Nasdaq fallback provides real quote data and intraday chart points when Yahoo is blocked.
- The app no longer invents fake stock prices for real tickers.
- If all live sources fail, the request returns an error instead of silently fabricating market data.

## Core Features

### Watchlist

- Default tickers: `SPY`, `AAPL`, `MSFT`, `TSLA`
- Add a ticker from the top input and press Enter or Load.
- Click a watchlist card to load its chart.
- Sort by default order, wave score, daily change, or RSI.
- Cards show price, daily change, wave state, confidence score, and RSI.

### Chart

The chart is drawn with Canvas 2D and supports:

- Candlesticks
- Close-price line
- Current price line and price tag
- Volume bars
- Crosshair with OHLC/date tooltip
- Mouse wheel zoom
- Drag-to-pan when zoomed
- Double-click to reset zoom
- Reset zoom button

### Timeframes

Available ranges:

- `1W`
- `1M`
- `3M`
- `6M`
- `1Y`
- `2Y`
- `5Y`

Changing timeframe reloads watchlist data for that range.

## Technical Analysis

### Elliott Wave Detection

The app uses a zigzag-style pivot detector to identify possible impulse or correction structures.

It computes:

- Pivot sequence
- Impulse or correction pattern
- Direction
- Current wave label
- Elliott rule checks
- Wave confidence score
- Fibonacci levels
- Wave targets and invalidation/stop reference

The count is heuristic and meant as a visual helper, not a definitive Elliott Wave count.

### Fibonacci Overlay

The Fibs toggle now always has a visible result:

- If a valid wave count exists, it uses wave-based Fibonacci levels.
- If no clean wave count exists, it falls back to visible range high/low Fibonacci levels.
- Key levels such as 38.2%, 50%, 61.8%, and 100% get stronger bands and labels.

### Support And Resistance

Support/resistance levels are detected from clustered local highs and lows.

The chart labels:

- `S` levels below current price
- `R` levels above current price
- Touch count for each detected level

### Buy Zones

The Zones overlay uses current wave forecast data, especially wave 4 / wave 5 target structures when available, to draw a simple green buy/interest band.

### RSI Divergence

RSI is calculated with a 14-period series. The app scans recent peaks/troughs for:

- Bearish divergence: price higher high, RSI lower high
- Bullish divergence: price lower low, RSI higher low

Detected divergence is drawn directly on the chart and summarized in the Risk panel.

### WMA200

The WMA200 overlay draws a dashed 200-period weighted moving average, matching one of the useful Wavefront overlays from `014-wavefront`.

### Volume Profile

The `VP` overlay creates a horizontal volume-at-price profile on the left side of the chart and marks the point of control.

### Regression Channel

The `Channel` overlay draws:

- Least-squares center line
- Upper band
- Lower band

The bands use roughly ±1.5 standard deviations around the regression line.

### Measured Move

The `MM` overlay projects AB=CD-style targets from the latest pivot sequence:

- 1.0x
- 1.272x
- 1.618x

### Fibonacci Time Zones

The `Fib time` overlay projects vertical time markers from the latest wave pivot using Fibonacci-style spacing:

```text
1, 2, 3, 5, 8, 13, 21, 34 bars
```

### Candlestick Labels

The `Candles` overlay labels recent simple candle patterns:

- Doji
- Hammer / Hanging type candles
- Bullish engulfing
- Bearish engulfing

This is a compact implementation, not the full 14-pattern engine from `014-wavefront`.

## Right Panel Tabs

### Waves

Shows:

- Latest close
- Daily change
- Wave score
- RSI 14
- Source and fallback warning, if any
- Pattern, direction, current wave
- Elliott rule checks
- Wave targets and invalidation/stop reference

### Scanner

Ranks watchlist tickers by wave score and shows:

- Symbol
- Pattern/current wave
- Daily change
- RSI
- Confidence score

Clicking a scanner row loads that ticker.

### Risk

Shows:

- Nearest support
- Nearest resistance
- Downside to support
- Upside to resistance
- Current RSI divergence state

### RS Rank

Compares each watchlist ticker against `SPY`.

It calculates:

- 1-month return
- 3-month return
- 3-month relative strength spread versus SPY

### Portfolio

Simple local position tracker.

For each position:

- Symbol
- Shares
- Entry price
- Entry wave
- Current value, if quote data exists
- P&L

Positions are saved in `localStorage`.

### Help

In-app summary of keyboard shortcuts and the Wavefront-style features that have been added.

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `1-9` | Jump to ticker by watchlist position |
| `←` / `→` | Step through timeframes |
| `W` | Toggle waves |
| `F` | Toggle Fibonacci |
| `R` | Toggle support/resistance |
| `Z` | Toggle zones |
| `V` | Toggle volume |
| `D` | Toggle RSI divergence |
| `P` | Toggle volume profile |
| `C` | Toggle regression channel |
| `M` | Toggle measured move |
| `T` | Toggle Fibonacci time zones |
| `K` | Toggle candlestick labels |
| `S` | Open scanner tab |
| `?` | Open help tab |
| `Escape` | Clear crosshair / cancel pan state |

## Persistence

Saved in browser `localStorage`:

- Watchlist
- Selected ticker
- Selected range
- Sort mode
- Overlay states
- Portfolio positions

Storage key:

```text
stock-analysis-wavefront-lite-v1
```

## File Map

```text
index.html    App shell and controls
styles.css    Shadcn-style dashboard styling
app.js        Frontend state, analysis, rendering, interactions
server.js     Static server and market-data proxy
package.json  npm start script
README.md     This living project description
```

## Known Limitations

- Yahoo can return `HTTP 429` when rate-limited. Nasdaq fallback fixes the fake-price problem but may provide shorter/intraday chart history rather than full OHLCV daily history.
- Nasdaq data can be delayed.
- The Elliott Wave detector is heuristic and should be reviewed manually.
- The candlestick detector is intentionally compact.
- There is no fundamentals tab yet.
- There is no full journal/export system yet.
- The app does not currently perform authenticated data-provider requests.

## Development Notes

When making a bigger feature/design/data-source change, update this README in the same commit or immediately after. This document should stay current enough that a new chat or future developer can inspect the repo and understand what exists without reconstructing the whole conversation.

## Changelog

### 2026-05-02 — Real Quote Fallback

- Removed the generated offline sample fallback for real tickers.
- Added Nasdaq quote/chart fallback when Yahoo is blocked or rate-limited.
- Updated frontend status text to show the data source and fallback state.
- Verified `NVDA` no longer shows the generated fake sample price.

### 2026-05-02 — Wavefront Feature Pass

- Added `1W` and `1M` timeframes.
- Added WMA200, volume profile, regression channel, measured move, Fibonacci time zones, and candlestick overlays.
- Added RS Rank, Portfolio, and Help tabs.
- Added keyboard shortcuts.
- Added drag-to-pan and double-click zoom reset.

### 2026-05-01 — Fibonacci Toggle Fix

- Made Fibs visible even when no valid Elliott count exists.
- Added range-based Fibonacci fallback.
- Improved Fibonacci label styling and status feedback.

### 2026-05-01 — Shadcn Dashboard Styling

- Reworked the interface into a light shadcn-style dashboard.
- Added carded chart workspace, segmented controls, improved sidebars, and cleaner tabs.

### 2026-05-01 — Initial App

- Built the first standalone stock dashboard in `015-stock analysis`.
- Added watchlist, chart, Elliott wave detection, Fibonacci, support/resistance, zones, volume, scanner, risk panel, and local server.

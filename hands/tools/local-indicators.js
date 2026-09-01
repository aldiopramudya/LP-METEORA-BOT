/**
 * Local technical indicators — self-hosted replacement for the Agent Meridian
 * /chart-indicators endpoint (which itself just proxies Jupiter candles and
 * computes standard indicators). No agentmeridian dependency.
 *
 * Candles: Jupiter datapi charts API (primary — same datapi.jup.ag ecosystem
 * the repo already uses), GeckoTerminal pool OHLCV (fallback). 15-minute
 * interval, ~300 candles, 5s timeout, 2-min in-memory cache per mint.
 *
 * Indicators (computed locally, shapes match what chart-indicators.js
 * expects from the remote payload): RSI (Wilder, length 2), Bollinger
 * (20, 2σ), Supertrend (ATR 10, multiplier 3), Fibonacci retracement over
 * the window high/low (.236/.382/.5/.618/.786).
 *
 * evaluateEntryPresets() ports the ENTRY side of every preset switch case
 * in tools/chart-indicators.js verbatim — used by the passive audition
 * (telemetry `entry_indicators` events), not (yet) by any trading gate.
 */

import { log } from "../logger.js";

const JUP_CHARTS_BASE = "https://datapi.jup.ag/v2/charts";
const GECKO_BASE = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_CANDLES = 300;

const _cache = new Map(); // mint → { at, value }

function num(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Candle sources ─────────────────────────────────────────────────────────

/** Jupiter datapi charts: {candles:[{time(sec),open,high,low,close,volume}]} */
async function fetchCandlesJupiter(mint, candles = DEFAULT_CANDLES) {
  const url = `${JUP_CHARTS_BASE}/${mint}?interval=15_MINUTE&to=${Date.now()}&candles=${candles}&type=price`;
  const data = await fetchJson(url);
  const rows = Array.isArray(data?.candles) ? data.candles : [];
  return rows
    .map((c) => ({ time: num(c.time), open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.volume) }))
    .filter((c) => c.close != null && c.high != null && c.low != null)
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

/** GeckoTerminal pool OHLCV fallback: data.attributes.ohlcv_list = [[ts,o,h,l,c,v],...] */
async function fetchCandlesGecko(pool, candles = DEFAULT_CANDLES) {
  const url = `${GECKO_BASE}/${pool}/ohlcv/minute?aggregate=15&limit=${Math.min(candles, 1000)}&currency=usd`;
  const data = await fetchJson(url);
  const rows = Array.isArray(data?.data?.attributes?.ohlcv_list) ? data.data.attributes.ohlcv_list : [];
  return rows
    .map((r) => ({ time: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) }))
    .filter((c) => c.close != null && c.high != null && c.low != null)
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

// ─── Indicator math ─────────────────────────────────────────────────────────

/** RSI with Wilder smoothing. Returns the latest value (0-100) or null. */
export function computeRsi(closes, length = 2) {
  if (!Array.isArray(closes) || closes.length < length + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= length;
  avgLoss /= length;
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(change, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-change, 0)) / length;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Bollinger bands (SMA + population σ). Returns { lower, middle, upper } or null. */
export function computeBollinger(closes, length = 20, mult = 2) {
  if (!Array.isArray(closes) || closes.length < length) return null;
  const window = closes.slice(-length);
  const middle = window.reduce((s, v) => s + v, 0) / length;
  const variance = window.reduce((s, v) => s + (v - middle) ** 2, 0) / length;
  const sd = Math.sqrt(variance);
  return { lower: middle - mult * sd, middle, upper: middle + mult * sd };
}

/**
 * Classic Supertrend (Wilder ATR). Returns
 * { value, direction: "bullish"|"bearish", breakUp, breakDown } or null.
 * breakUp/breakDown = the direction flipped on the LATEST candle.
 */
export function computeSupertrend(candles, atrLength = 10, mult = 3) {
  if (!Array.isArray(candles) || candles.length < atrLength + 2) return null;

  // Wilder ATR series
  const atr = new Array(candles.length).fill(null);
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    if (i <= atrLength) {
      trSum += tr;
      if (i === atrLength) atr[i] = trSum / atrLength;
    } else {
      atr[i] = (atr[i - 1] * (atrLength - 1) + tr) / atrLength;
    }
  }

  let finalUpper = null;
  let finalLower = null;
  let direction = null; // 1 bullish, -1 bearish
  let value = null;
  const directions = new Array(candles.length).fill(null);

  for (let i = atrLength; i < candles.length; i++) {
    if (atr[i] == null) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + mult * atr[i];
    const basicLower = mid - mult * atr[i];
    const prevClose = candles[i - 1].close;

    finalUpper = finalUpper == null || basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = finalLower == null || basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

    const close = candles[i].close;
    if (direction == null) {
      direction = close >= finalUpper ? 1 : -1;
    } else if (direction === -1 && close > finalUpper) {
      direction = 1;
    } else if (direction === 1 && close < finalLower) {
      direction = -1;
    }
    directions[i] = direction;
    value = direction === 1 ? finalLower : finalUpper;
  }

  if (direction == null) return null;
  const last = candles.length - 1;
  const prevDirection = directions[last - 1];
  return {
    value,
    direction: direction === 1 ? "bullish" : "bearish",
    breakUp: prevDirection === -1 && direction === 1,
    breakDown: prevDirection === 1 && direction === -1,
  };
}

/** Fibonacci retracement levels over the window high/low. */
export function computeFibonacci(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const range = high - low;
  const levels = {};
  for (const ratio of [0.236, 0.382, 0.5, 0.618, 0.786]) {
    levels[ratio.toFixed(3)] = high - range * ratio;
  }
  return { high, low, levels };
}

/**
 * Compute the full payload in the shape chart-indicators.js expects
 * (payload.latest.{candle,previousCandle,rsi,bollinger,supertrend,states,fibonacci}).
 */
export function computeIndicators(candles, { rsiLength = 2, bbLength = 20, bbMult = 2, atrLength = 10, stMult = 3 } = {}) {
  if (!Array.isArray(candles) || candles.length < Math.max(bbLength, atrLength + 2, rsiLength + 1)) return null;
  const closes = candles.map((c) => c.close);
  const rsi = computeRsi(closes, rsiLength);
  const bollinger = computeBollinger(closes, bbLength, bbMult);
  const supertrend = computeSupertrend(candles, atrLength, stMult);
  const fibonacci = computeFibonacci(candles);
  return {
    latest: {
      candle: { close: closes[closes.length - 1] },
      previousCandle: { close: closes[closes.length - 2] ?? null },
      rsi: { value: rsi },
      bollinger: bollinger || {},
      supertrend: supertrend ? { value: supertrend.value, direction: supertrend.direction } : {},
      states: {
        supertrendBreakUp: !!supertrend?.breakUp,
        supertrendBreakDown: !!supertrend?.breakDown,
      },
      fibonacci: fibonacci || { levels: {} },
    },
  };
}

// ─── Preset evaluation (ENTRY side, ported verbatim from chart-indicators.js) ─

export const ENTRY_PRESETS = [
  "supertrend_break",
  "rsi_reversal",
  "bollinger_reversion",
  "rsi_plus_supertrend",
  "supertrend_or_rsi",
  "bb_plus_rsi",
  "fibo_reclaim",
  "fibo_reject",
];

export function evaluateEntryPresets(payload, { oversold = 30, overbought = 80 } = {}) {
  const latest = payload?.latest || {};
  const close = num(latest.candle?.close);
  const previousClose = num(latest.previousCandle?.close);
  const rsi = num(latest.rsi?.value);
  const lowerBand = num(latest.bollinger?.lower);
  const supertrendValue = num(latest.supertrend?.value);
  const direction = String(latest.supertrend?.direction || "unknown");
  const isBullish = direction === "bullish";
  const breakUp = !!latest.states?.supertrendBreakUp;
  const fibLevels = latest.fibonacci?.levels || {};
  const fib50 = num(fibLevels["0.500"]);
  const fib618 = num(fibLevels["0.618"]);
  const fib786 = num(fibLevels["0.786"]);

  const crossedUp = (level) =>
    level != null && close != null && previousClose != null && previousClose < level && close >= level;
  const crossedDown = (level) =>
    level != null && close != null && previousClose != null && previousClose > level && close <= level;

  const stBullConfirm = breakUp || (isBullish && close != null && supertrendValue != null && close >= supertrendValue);
  const rsiOversold = rsi != null && rsi <= oversold;

  const presets = {
    supertrend_break: stBullConfirm,
    rsi_reversal: rsiOversold,
    bollinger_reversion: close != null && lowerBand != null && close <= lowerBand,
    rsi_plus_supertrend: rsiOversold && (breakUp || isBullish),
    supertrend_or_rsi: stBullConfirm || rsiOversold,
    bb_plus_rsi: close != null && lowerBand != null && close <= lowerBand && rsiOversold,
    fibo_reclaim: crossedUp(fib618) || crossedUp(fib50) || crossedUp(fib786),
    fibo_reject: crossedDown(fib618) || crossedDown(fib50),
  };

  // Nearest fib level to the current close (for the raw summary)
  let nearestFib = null;
  let nearestDist = Infinity;
  for (const [ratio, price] of Object.entries(fibLevels)) {
    const p = num(price);
    if (p == null || close == null) continue;
    const dist = Math.abs(close - p);
    if (dist < nearestDist) { nearestDist = dist; nearestFib = ratio; }
  }

  return {
    presets,
    raw: {
      rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
      close_vs_lower_band_pct: close != null && lowerBand != null && lowerBand !== 0
        ? Number((((close - lowerBand) / Math.abs(lowerBand)) * 100).toFixed(2))
        : null,
      supertrend_dir: direction,
      rsi_zone: rsi == null ? "unknown" : rsi <= oversold ? "oversold" : rsi >= overbought ? "overbought" : "neutral",
      nearest_fib_level: nearestFib,
    },
  };
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Fetch candles (Jupiter → GeckoTerminal fallback), compute indicators and
 * evaluate all 8 entry presets. Returns
 * { source, candle_count, presets, raw } or null on any failure — callers
 * are passive consumers and must treat null as "no data, no event".
 */
export async function getLocalEntryIndicators({ mint, pool = null, candles = DEFAULT_CANDLES } = {}) {
  if (!mint) return null;
  const cached = _cache.get(mint);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let rows = [];
  let source = null;
  try {
    rows = await fetchCandlesJupiter(mint, candles);
    if (rows.length > 0) source = "jupiter";
  } catch (error) {
    log("indicators_warn", `Jupiter candles failed for ${mint.slice(0, 8)}: ${error.message}`);
  }
  if (rows.length === 0 && pool) {
    try {
      rows = await fetchCandlesGecko(pool, candles);
      if (rows.length > 0) source = "geckoterminal";
    } catch (error) {
      log("indicators_warn", `GeckoTerminal candles failed for ${String(pool).slice(0, 8)}: ${error.message}`);
    }
  }
  if (rows.length === 0) return null;

  const payload = computeIndicators(rows);
  if (!payload) return null;
  const evaluated = evaluateEntryPresets(payload);
  const value = { source, candle_count: rows.length, ...evaluated };
  _cache.set(mint, { at: Date.now(), value });
  if (_cache.size > 200) {
    // Drop oldest entries — audition volume is ~deploys/day, this is just a bound.
    const oldest = [..._cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [key] of oldest) _cache.delete(key);
  }
  return value;
}

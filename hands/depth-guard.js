/**
 * Depth Guard — deterministic in-range dump guard (user-approved spec 2026-07-12/14).
 *
 * Evidence base: every catastrophic loss (pendu, Bullcat, reptilecoin, SCAM)
 * happened while price was still INSIDE the bin range — PnL-based SL fires too
 * late (mark price lies on thin books) and the OOR timer never starts. This
 * guard watches how deep price has penetrated the range from the top and cuts
 * while the token side is still small and the exit is still cheap.
 *
 *   depth% = (upper_bin − active_bin) / (upper_bin − lower_bin) × 100
 *            0% = price at top of our range · 100% = at the floor · >100% = below
 *
 * Layers:
 *   L1  depth ≥ depthAlertPct (50) for 2 consecutive ticks → Telegram alert,
 *       open a watch episode.
 *   L2  once per episode: current 5m volume vs SMA20 of closed 5m bars.
 *       Volume BELOW average = quiet drift, no buyers, no bounce fuel → CUT now.
 *       Volume above = real fight → L3 candle trial.
 *   L3  grace window depthGraceWindowMin (5m): every 1m candle that CLOSES
 *       during the window must be green AND carry ≥ depthCandleVolRatio (0.8×)
 *       of the previous candle's volume. One failed candle → CUT immediately.
 *   L4  window expires with depth still ≥ depthRecoveryPct (40) → CUT.
 *       Recovery to < depthRecoveryPct at any point → stand down, back to L0.
 *   Kill-switches (any state, any time):
 *       depth ≥ depthHardCutPct (65) → CUT. Active bin > depthBelowRangeBins
 *       (10) below the range floor → rug gap, CUT.
 *
 * After a cut fires, the caller applies a depthReentryCooldownMin (45m)
 * pool+mint cooldown via pool-memory so the screener can't revenge-enter.
 *
 * The cut decision is STICKY: once decided, the same signal is emitted every
 * tick until the position closes, so registerExitSignal's 2-tick confirm and
 * the direct-close path in the fast poller work unchanged. SL / trailing /
 * deterministic rules always run first — this guard only speaks when they are
 * silent. Candle data: datapi.jup.ag (self-hosted policy, no third parties).
 */
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { sendMessage } from "./telegram.js";
import { getTrackedPosition } from "./state.js";
import { applyExternalCooldown } from "./pool-memory.js";

const LOG_DIR = repoPath("logs");
const JUP_CHARTS_BASE = "https://datapi.jup.ag/v2/charts";

// posId → { zoneTicks, episode, cut }
const guard = new Map();

function guardConfig() {
  const m = config.management;
  return {
    enabled: m.depthGuardEnabled ?? false,
    alertPct: Number(m.depthAlertPct ?? 50),
    recoveryPct: Number(m.depthRecoveryPct ?? 40),
    hardCutPct: Number(m.depthHardCutPct ?? 65),
    graceWindowMin: Number(m.depthGraceWindowMin ?? 5),
    candleVolRatio: Number(m.depthCandleVolRatio ?? 0.8),
    belowRangeBins: Number(m.depthBelowRangeBins ?? 10),
    reentryCooldownMin: Number(m.depthReentryCooldownMin ?? 45),
  };
}

function writeLog(event) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `depth-guard-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch { /* telemetry must never break trading */ }
}

// ─── Candles (datapi.jup.ag, short in-memory cache) ─────────────────────────

const _candleCache = new Map(); // `${mint}:${interval}` → { at, rows }

async function fetchCandles(mint, interval, count) {
  const key = `${mint}:${interval}`;
  const ttlMs = interval === "1_MINUTE" ? 5_000 : 30_000;
  const hit = _candleCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rows;
  const url = `${JUP_CHARTS_BASE}/${mint}?interval=${interval}&to=${Date.now()}&candles=${count}&type=price`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`candles HTTP ${res.status}`);
  const data = await res.json();
  const rows = (Array.isArray(data?.candles) ? data.candles : [])
    .map((c) => ({
      time: Number(c.time),
      open: Number(c.open),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
  _candleCache.set(key, { at: Date.now(), rows });
  return rows;
}

// ─── Depth math ──────────────────────────────────────────────────────────────

export function computeDepthPct(p, tracked) {
  const upper = Number(p.upper_bin ?? tracked?.bin_range?.max);
  const lower = Number(p.lower_bin ?? tracked?.bin_range?.min);
  const active = Number(p.active_bin);
  if (![upper, lower, active].every(Number.isFinite) || upper <= lower) return null;
  return ((upper - active) / (upper - lower)) * 100;
}

// ─── State machine ───────────────────────────────────────────────────────────

function cut(state, p, depth, layer, reason) {
  state.cut = { reason };
  writeLog({ type: "cut", layer, position: p.position, pair: p.pair, depth: round1(depth), reason });
  log("state", `[Depth Guard] CUT (${layer}) ${p.pair}: ${reason}`);
  return state.cut;
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}

function baseMintOf(p, tracked) {
  return p.base_mint || tracked?.signal_snapshot?.base_mint || null;
}

async function openEpisode(state, p, depth, cfg) {
  state.episode = {
    startedAt: Date.now(),
    volumeVerdict: "pending", // pending | high | low | unavailable
    lastJudgedCandleTime: Math.floor(Date.now() / 1000),
    candlesJudged: 0,
  };
  writeLog({ type: "episode_open", position: p.position, pair: p.pair, depth: round1(depth) });
  log("state", `[Depth Guard] ${p.pair} entered danger zone: depth ${round1(depth)}%`);
  sendMessage(
    `⚠️ DEPTH GUARD — ${p.pair}\nPrice has eaten ${round1(depth)}% of our range depth.\nChecking 5m volume context, then 1m candle trial for ${cfg.graceWindowMin} min. Hard cut at ${cfg.hardCutPct}%.`,
  ).catch(() => {});
}

function standDown(state, p, depth) {
  writeLog({ type: "stand_down", position: p.position, pair: p.pair, depth: round1(depth), candles_judged: state.episode?.candlesJudged ?? 0 });
  log("state", `[Depth Guard] ${p.pair} recovered: depth ${round1(depth)}% — standing down`);
  state.episode = null;
  state.zoneTicks = 0;
}

/**
 * L2 — one-shot volume context: current 5m volume (max of running bar and last
 * closed bar) vs SMA20 of the closed bars before it.
 */
async function volumeContextCheck(state, p, mint, cfg, depth) {
  const ep = state.episode;
  try {
    const rows = await fetchCandles(mint, "5_MINUTE", 23);
    if (rows.length < 22) throw new Error(`only ${rows.length} 5m candles`);
    const partial = rows[rows.length - 1];
    const lastClosed = rows[rows.length - 2];
    const smaWindow = rows.slice(-22, -2); // 20 closed bars before the last closed
    const sma20 = smaWindow.reduce((s, c) => s + c.volume, 0) / smaWindow.length;
    const current = Math.max(partial.volume, lastClosed.volume);
    ep.volumeVerdict = current >= sma20 ? "high" : "low";
    writeLog({
      type: "volume_check", position: p.position, pair: p.pair, depth: round1(depth),
      current_vol: current, sma20: sma20, verdict: ep.volumeVerdict,
    });
  } catch (e) {
    // No volume data → can't run the candle trial. Fall back to depth-only
    // guard: recovery / hard-cut / grace-expiry still protect the position.
    ep.volumeVerdict = "unavailable";
    writeLog({ type: "volume_check", position: p.position, pair: p.pair, verdict: "unavailable", error: e.message });
  }
}

/**
 * L3 — judge every 1m candle that closed during the grace window: must be
 * green AND carry ≥ candleVolRatio × previous candle's volume.
 * Returns null (all passed / nothing new) or a failure detail string.
 */
async function candleTrial(state, p, mint, cfg) {
  const ep = state.episode;
  const rows = await fetchCandles(mint, "1_MINUTE", 12).catch(() => null);
  if (!rows || rows.length < 3) return null; // no data this tick — try again next tick
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const isClosed = i < rows.length - 1 || c.time + 60 <= nowSec;
    if (!isClosed || c.time <= ep.lastJudgedCandleTime) continue;
    const prev = rows[i - 1];
    const green = c.close >= c.open;
    const volOk = c.volume >= cfg.candleVolRatio * prev.volume;
    ep.lastJudgedCandleTime = c.time;
    ep.candlesJudged += 1;
    writeLog({
      type: "candle_verdict", position: p.position, pair: p.pair,
      candle_time: c.time, green, vol: c.volume, prev_vol: prev.volume, vol_ok: volOk,
      pass: green && volOk,
    });
    if (!green || !volOk) {
      return `1m candle ${!green ? "red" : ""}${!green && !volOk ? " + " : ""}${!volOk ? `volume fading (${Math.round(c.volume)} < ${cfg.candleVolRatio}× ${Math.round(prev.volume)})` : ""}`;
    }
  }
  return null;
}

/**
 * Evaluate the guard for one position on one fast-poller tick.
 * Returns null (no action) or { reason } — a sticky cut decision.
 * Never throws; all network failures degrade to depth-only protection.
 */
export async function evaluateDepthGuard(p) {
  const cfg = guardConfig();
  if (!cfg.enabled) return null;
  if (!p?.position) return null;

  const tracked = getTrackedPosition(p.position);
  if (!tracked || tracked.closed) { guard.delete(p.position); return null; }

  const depth = computeDepthPct(p, tracked);
  if (depth == null) return null;

  let state = guard.get(p.position);
  if (!state) { state = { zoneTicks: 0, episode: null, cut: null }; guard.set(p.position, state); }
  if (state.cut) return state.cut; // sticky until the position closes

  // Kill-switch: rug gap — price far below the range floor, no timer, no debate.
  const lower = Number(p.lower_bin ?? tracked?.bin_range?.min);
  const active = Number(p.active_bin);
  if (Number.isFinite(lower) && Number.isFinite(active) && active < lower - cfg.belowRangeBins) {
    return cut(state, p, depth, "below_range",
      `Depth guard: price ${lower - active} bins below range floor (>${cfg.belowRangeBins}) — rug pattern, instant cut`);
  }

  // Kill-switch: hard depth cut in any state.
  if (depth >= cfg.hardCutPct) {
    return cut(state, p, depth, "hard_cut",
      `Depth guard: depth ${round1(depth)}% breached hard-cut ${cfg.hardCutPct}%`);
  }

  // L0/L1 — outside an episode: arm on 2 consecutive ticks in the zone.
  if (!state.episode) {
    if (depth >= cfg.alertPct) {
      state.zoneTicks += 1;
      if (state.zoneTicks >= 2) await openEpisode(state, p, depth, cfg);
    } else {
      state.zoneTicks = 0;
    }
    return null;
  }

  const ep = state.episode;

  // L4 recovery — bounce proved itself, stand down.
  if (depth < cfg.recoveryPct) { standDown(state, p, depth); return null; }

  // L2 — volume context, once per episode.
  if (ep.volumeVerdict === "pending") {
    const mint = baseMintOf(p, tracked);
    if (!mint) { ep.volumeVerdict = "unavailable"; }
    else await volumeContextCheck(state, p, mint, cfg, depth);
    if (ep.volumeVerdict === "low") {
      return cut(state, p, depth, "low_volume",
        `Depth guard: depth ${round1(depth)}% on below-average 5m volume — quiet drift, no bounce fuel`);
    }
  }

  // L3 — candle trial (only when volume said "fight is on").
  if (ep.volumeVerdict === "high") {
    const mint = baseMintOf(p, tracked);
    const failure = mint ? await candleTrial(state, p, mint, cfg) : null;
    if (failure) {
      return cut(state, p, depth, "candle_fail",
        `Depth guard: bounce failed the candle trial at depth ${round1(depth)}% — ${failure}`);
    }
  }

  // L4 expiry — grace window over and still in the zone.
  if (Date.now() - ep.startedAt >= cfg.graceWindowMin * 60 * 1000) {
    return cut(state, p, depth, "grace_expired",
      `Depth guard: still at depth ${round1(depth)}% after ${cfg.graceWindowMin}m grace — bounce never came`);
  }

  return null;
}

/**
 * Called by the poller after a DEPTH_GUARD close fires: re-entry cooldown on
 * pool + base mint, then clear the runtime state.
 */
export function onDepthCutClosed(p) {
  const cfg = guardConfig();
  const tracked = getTrackedPosition(p.position);
  try {
    applyExternalCooldown({
      pool_address: p.pool,
      base_mint: baseMintOf(p, tracked),
      hours: cfg.reentryCooldownMin / 60,
      reason: "depth guard cut",
    });
  } catch (e) {
    log("cron_error", `Depth guard cooldown failed: ${e.message}`);
  }
  writeLog({ type: "cut_closed", position: p.position, pair: p.pair, reentry_cooldown_min: cfg.reentryCooldownMin });
  guard.delete(p.position);
}

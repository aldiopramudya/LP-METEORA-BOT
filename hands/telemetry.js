/**
 * Telemetry — append-only JSONL event stream for the Brain learning loop.
 *
 * Purely passive: every write is wrapped so a telemetry failure can never
 * break a trading cycle, and nothing here is ever fed back into the LLM
 * prompt. Files rotate daily (logs/telemetry-YYYY-MM-DD.jsonl), same
 * pattern as logger.js. Consumed by Brain's postmortem/distiller jobs
 * (LP Provider/Brain). Lines are compact JSON — one event per line.
 *
 * Event types:
 *   candidate — every screening / opportunity-poll evaluation (pass|reject)
 *   entry     — a position was deployed
 *   tick      — 10-min management-cycle snapshot of an open position
 *   close     — a position was closed (realized outcome)
 */
import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";

const LOG_DIR = repoPath("logs");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctChange(from, to) {
  if (from == null || to == null || from === 0) return null;
  return Number((((to - from) / Math.abs(from)) * 100).toFixed(2));
}

function write(event) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `telemetry-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch { /* telemetry must never break a cycle */ }
}

/**
 * Full params vector from a condensed candidate pool
 * (screening.js condensePool shape; GMGN-condensed pools share it).
 * gmgn_* fields are copied only when the pipeline already fetched them —
 * telemetry itself never makes API calls.
 */
export function candidateParams(p) {
  try {
    const volume = num(p?.volume_window);
    const mcap = num(p?.mcap);
    const params = {
      volatility: num(p?.volatility),
      volume,
      mcap,
      volume_mcap_ratio: volume != null && mcap != null && mcap > 0 ? Number((volume / mcap).toFixed(4)) : null,
      fee_tvl_ratio: num(p?.fee_active_tvl_ratio),
      tvl: num(p?.tvl),
      active_tvl: num(p?.active_tvl),
      organic: num(p?.organic_score ?? p?.base?.organic),
      holders: num(p?.holders),
      token_age_hours: num(p?.token_age_hours),
      bin_step: num(p?.bin_step),
      launchpad: p?.launchpad ?? null,
    };
    for (const [key, value] of Object.entries(p || {})) {
      if (key.startsWith("gmgn_") && ["number", "string", "boolean"].includes(typeof value)) {
        params[key] = value;
      }
    }
    return params;
  } catch {
    return {};
  }
}

/**
 * candidate event. verdict: "pass" | "reject". failed_gates lists ALL gates
 * that fired for this candidate (parametric gates are always all evaluated;
 * file-backed gates — cooldowns/sticky/local-top — short-circuit for cost).
 */
export function recordCandidate({ cycle, pool, verdict, failed_gates = [], degen = null, extra = null }) {
  try {
    write({
      ts: new Date().toISOString(),
      type: "candidate",
      cycle: cycle || "screening",
      mint: pool?.base?.mint ?? null,
      symbol: pool?.base?.symbol ?? null,
      pool: pool?.pool ?? null,
      verdict,
      failed_gates,
      params: {
        ...candidateParams(pool),
        ...(degen != null && Number.isFinite(Number(degen)) ? { degen: Number(Number(degen).toFixed(1)) } : {}),
        ...(extra || {}),
      },
    });
  } catch { /* never break a cycle */ }
}

/** entry event — emitted by executor.js after a successful deploy_position. */
export function recordEntry({ args = {}, result = {} }) {
  try {
    const volume = num(args.entry_volume);
    const mcap = num(args.entry_mcap);
    write({
      ts: new Date().toISOString(),
      type: "entry",
      mint: args.base_mint ?? result.base_mint ?? null,
      pool: result.pool ?? args.pool_address ?? null,
      pool_name: result.pool_name ?? args.pool_name ?? null,
      position: result.position ?? null,
      amount_sol: num(args.amount_y ?? args.amount_sol),
      strategy: args.strategy ?? null,
      bin_range: result.bin_range ?? null,
      size_scaling: args.size_scaling_note ?? null,
      params: {
        volatility: num(args.volatility),
        fee_tvl_ratio: num(args.fee_tvl_ratio),
        organic: num(args.organic_score),
        mcap,
        tvl: num(args.entry_tvl),
        volume,
        volume_mcap_ratio: volume != null && mcap != null && mcap > 0 ? Number((volume / mcap).toFixed(4)) : null,
        holders: num(args.entry_holders),
        bin_step: num(args.bin_step),
        token_age_hours: num(args.token_age_hours),
      },
    });
  } catch { /* never break a cycle */ }
}

/**
 * entry_indicators event — passive audition of all 8 local indicator entry
 * presets, computed fire-and-forget after a deploy (tools/local-indicators.js).
 */
export function recordEntryIndicators({ position = null, mint = null, indicators = {} }) {
  try {
    write({
      ts: new Date().toISOString(),
      type: "entry_indicators",
      position,
      mint,
      source: indicators.source ?? null,
      candle_count: indicators.candle_count ?? null,
      presets: indicators.presets ?? {},
      raw: indicators.raw ?? {},
    });
  } catch { /* never break a cycle */ }
}

/**
 * entry_gmgn event — passive GMGN wallet-composition snapshot at deploy time
 * (one paced call per deploy). available:false is still emitted so the
 * distiller can see coverage.
 */
export function recordEntryGmgn({ position = null, mint = null, analysis = {} }) {
  try {
    const { mint: _ignored, ...fields } = analysis || {};
    write({
      ts: new Date().toISOString(),
      type: "entry_gmgn",
      position,
      mint,
      ...fields,
    });
  } catch { /* never break a cycle */ }
}

// Previous tick per position for delta computation (in-memory; resets on restart).
const _lastTick = new Map();

/**
 * tick event — piggybacks on the management-cycle snapshot site. `detail` is
 * the pool-discovery detail the cycle already fetched (may be null); `pos` is
 * the live position object. No extra API calls are made here.
 */
export function recordTick({ pos = {}, detail = null }) {
  try {
    const position = pos.position ?? null;
    const snap = {
      price: num(detail?.pool_price),
      mcap: num(detail?.token_x?.market_cap),
      tvl: num(detail?.tvl ?? detail?.active_tvl),
      active_tvl: num(detail?.active_tvl),
      fee_tvl_ratio: num(detail?.fee_active_tvl_ratio),
      holders: num(detail?.base_token_holders),
      active_bin: num(pos.active_bin),
      in_range: pos.in_range ?? null,
      pnl_pct: num(pos.pnl_pct),
      pnl_usd: num(pos.pnl_usd),
      unclaimed_fees_usd: num(pos.unclaimed_fees_usd),
    };
    const prev = position ? _lastTick.get(position) : null;
    const deltas = prev
      ? {
          minutes: Math.round((Date.now() - prev.at) / 60000),
          d_price_pct: pctChange(prev.snap.price, snap.price),
          d_mcap_pct: pctChange(prev.snap.mcap, snap.mcap),
          d_tvl_pct: pctChange(prev.snap.tvl, snap.tvl),
          d_pnl_pct: snap.pnl_pct != null && prev.snap.pnl_pct != null
            ? Number((snap.pnl_pct - prev.snap.pnl_pct).toFixed(2))
            : null,
        }
      : null;
    if (position) _lastTick.set(position, { at: Date.now(), snap });
    write({
      ts: new Date().toISOString(),
      type: "tick",
      position,
      pool: pos.pool ?? null,
      mint: pos.base_mint ?? null,
      pair: pos.pair ?? null,
      ...snap,
      deltas,
    });
  } catch { /* never break a cycle */ }
}

/** swap-back event — post-close Jupiter autoswap slippage (emitted by executor). */
export function recordSwapBack(event = {}) {
  try {
    write({
      ts: new Date().toISOString(),
      type: "swap_back",
      position: event.position ?? null,
      mint: event.mint ?? null,
      tx: event.tx ?? null,
      usd_in: num(event.usd_in),
      sol_out: num(event.sol_out),
      usd_out: num(event.usd_out),
      slippage_usd: num(event.slippage_usd),
      slippage_pct: num(event.slippage_pct),
      quote_out_sol: num(event.quote_out_sol),
      exec_vs_quote_pct: num(event.exec_vs_quote_pct),
      price_impact_pct: num(event.price_impact_pct),
      gas_sol: num(event.gas_sol),
      amount_sol: num(event.amount_sol),
    });
  } catch { /* never break a cycle */ }
}

/** close event — emitted by lessons.js recordPerformance (all close paths). */
export function recordClose(entry = {}) {
  try {
    const position = entry.position ?? null;
    if (position) _lastTick.delete(position);
    write({
      ts: new Date().toISOString(),
      type: "close",
      mint: entry.base_mint ?? null,
      pool: entry.pool ?? null,
      pool_name: entry.pool_name ?? null,
      position,
      pnl_usd: num(entry.pnl_usd),
      pnl_pct: num(entry.pnl_pct),
      fees_earned_usd: num(entry.fees_earned_usd),
      close_reason: entry.close_reason ?? null,
      minutes_held: num(entry.minutes_held),
      range_efficiency: num(entry.range_efficiency),
      params: {
        strategy: entry.strategy ?? null,
        volatility: num(entry.volatility),
        fee_tvl_ratio: num(entry.fee_tvl_ratio),
        organic: num(entry.organic_score),
        bin_step: num(entry.bin_step),
        amount_sol: num(entry.amount_sol),
        entry_mcap: num(entry.entry_mcap),
        entry_tvl: num(entry.entry_tvl),
        entry_volume: num(entry.entry_volume),
        exit_mcap: num(entry.exit_mcap),
        exit_tvl: num(entry.exit_tvl),
        exit_volume: num(entry.exit_volume),
      },
    });
  } catch { /* never break a cycle */ }
}

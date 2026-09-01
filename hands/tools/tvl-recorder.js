/**
 * TVL recorder — per-minute pool-liquidity snapshots for every OPEN position.
 * Purely observational (user-approved 2026-07-14): zero trading impact.
 *
 * Purpose: build the dataset the rug-vs-shakeout question actually needs.
 * The V2 rug-detection hypothesis ("real rugs drain TVL at the dump minute,
 * shakeouts don't") could not be tested from entry_tvl/exit_tvl — wrong
 * resolution. This records active_tvl + volume + fee per open pool per minute
 * so a future backtest can join candle dumps against liquidity behaviour.
 *
 * Output: logs/tvl-YYYY-MM-DD.jsonl — {ts, pool, pool_name, active_tvl,
 * volume_24h, fee_24h, positions} one line per open pool per tick.
 * Reads state.json directly (no coupling to the trading loop); self-starts on
 * import from executor.js. Failures are swallowed — never touches trading.
 */
import fs from "fs";
import path from "path";
import { repoPath } from "../repo-root.js";

const STATE_FILE = repoPath("state.json");
const LOG_DIR = repoPath("logs");
const INTERVAL_MS = 60 * 1000;

function openPools() {
  try {
    const positions = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).positions || {};
    const byPool = new Map();
    for (const p of Object.values(positions)) {
      if (p.closed || !p.pool) continue;
      if (!byPool.has(p.pool)) byPool.set(p.pool, { pool_name: p.pool_name || null, count: 0 });
      byPool.get(p.pool).count++;
    }
    return byPool;
  } catch { return new Map(); }
}

async function snapshotPool(pool) {
  const url = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${pool}`)}&timeframe=24h`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const p = ((await res.json()).data || [])[0];
  if (!p) return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return {
    active_tvl: num(p.active_tvl) ?? num(p.tvl),
    volume_24h: num(p.volume),
    fee_24h: num(p.fee_window) ?? num(p.fee),
  };
}

async function tick() {
  try {
    const pools = openPools();
    if (!pools.size) return;
    const file = path.join(LOG_DIR, `tvl-${new Date().toISOString().slice(0, 10)}.jsonl`);
    for (const [pool, meta] of pools) {
      const snap = await snapshotPool(pool).catch(() => null);
      if (!snap) continue;
      fs.appendFileSync(file, JSON.stringify({
        ts: new Date().toISOString(), pool, pool_name: meta.pool_name,
        positions: meta.count, ...snap,
      }) + "\n");
      await new Promise((r) => setTimeout(r, 300)); // gentle on the API
    }
  } catch { /* observational — never throw into the caller's world */ }
}

let _started = false;
export function startTvlRecorder() {
  if (_started) return;
  _started = true;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* exists */ }
  const t = setInterval(() => { void tick(); }, INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();
  setTimeout(() => { void tick(); }, 20_000);
}

startTvlRecorder();

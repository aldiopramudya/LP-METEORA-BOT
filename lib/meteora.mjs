// Sumber data pool: Meteora discovery (list + token meta) + datapi detail (volume/fee per timeframe) + Dexscreener (chg 1h).
import { jget, num } from "./util.mjs";

const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag";
const DATAPI = "https://dlmm.datapi.meteora.ag";
const SOL = "So11111111111111111111111111111111111111112";

/** Daftar kandidat pool SOL-quote, TVL ≥ minTvl, urut fee/TVL 24h. */
export async function discover(minTvl, pageSize = 100, maxPages = 10) {
  // 08-28: halaman 1 cuma ~50 pool SOL; universe TVL>20k ada ~210 → paging sampai habis (after_key)
  const rows = []; let after = null;
  for (let i = 0; i < maxPages; i++) {
    const d = await jget(`${DISCOVERY}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}&sort_by=fee_tvl_ratio:desc&timeframe=24h${after ? `&after_key=${encodeURIComponent(after)}` : ""}`, { timeoutMs: 15000 });
    rows.push(...(d?.data || []));
    if (!d?.has_more || !d?.after_key) break;
    after = d.after_key;
  }
  return rows.filter((p) => p.pool_type === "dlmm" && p.token_y?.address === SOL && !p.is_blacklisted).map((p) => ({
    pool: p.pool_address, name: p.name, sym: p.token_x?.symbol || "?", mint: p.token_x?.address,
    binStep: num(p.dlmm_params?.bin_step), baseFeePct: num(p.fee_pct),
    tvl: num(p.tvl), feeTvl24h: num(p.fee_tvl_ratio), fee24hUsd: num(p.fee), vol24hUsd: num(p.volume),
    poolAgeH: p.pool_created_at ? (Date.now() - num(p.pool_created_at)) / 3600e3 : null,
    tokenAgeH: p.token_x?.created_at ? (Date.now() - num(p.token_x.created_at)) / 3600e3 : null,
    holders: num(p.base_token_holders ?? p.token_x?.holders), mcap: num(p.token_x?.market_cap),
    price: num(p.pool_price), maxPrice24h: num(p.max_price), minPrice24h: num(p.min_price),
    organic: num(p.token_x?.organic_score), topHoldersPct: num(p.token_x?.top_holders_pct), devPct: num(p.token_x?.dev_balance_pct),
    tags: p.token_x?.tags || [], tokenProgram: p.token_x?.token_program || null,
  }));
}

/** Detail 1 pool: volume/fee per timeframe (buat filter anti-burst). */
export async function poolDetail(pool) {
  const p = await jget(`${DATAPI}/pools/${pool}`, { timeoutMs: 15000 });
  return {
    vol30m: num(p.volume?.["30m"]), vol1h: num(p.volume?.["1h"]), vol24h: num(p.volume?.["24h"]),
    fees1h: num(p.fees?.["1h"]), fees24h: num(p.fees?.["24h"]),
    feeTvl1h: num(p.fee_tvl_ratio?.["1h"]), feeTvl24h: num(p.fee_tvl_ratio?.["24h"]),
    tvl: num(p.tvl), price: num(p.current_price), dynamicFeePct: num(p.dynamic_fee_pct),
    holders: num(p.token_x?.holders), mcap: num(p.token_x?.market_cap), createdAt: num(p.created_at) || null,
  };
}

/** Dexscreener: perubahan harga 1h/24h (%). Null kalau ga ada. */
export async function priceChange(pool) {
  try {
    const d = await jget(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, { timeoutMs: 8000 });
    const p = d?.pair || d?.pairs?.[0];
    if (!p) return null;
    return { chg1h: num(p.priceChange?.h1), chg24h: num(p.priceChange?.h24), liqUsd: num(p.liquidity?.usd), mcap: num(p.marketCap || p.fdv) };
  } catch { return null; }
}

let _sol = { v: 0, ts: 0 };
export async function solUsd(fallback = 100) {
  if (Date.now() - _sol.ts < 10 * 60e3 && _sol.v > 0) return _sol.v;
  try { const d = await jget(`https://lite-api.jup.ag/price/v3?ids=${SOL}`); const v = num(d?.[SOL]?.usdPrice); if (v > 0) _sol = { v, ts: Date.now() }; } catch {}
  return _sol.v > 0 ? _sol.v : fallback;
}

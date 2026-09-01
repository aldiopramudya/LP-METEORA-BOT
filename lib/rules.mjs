// ATURAN — fungsi murni, tanpa I/O. Semua angka dari config.json. Dites di test/rules.test.mjs.
// Sumber angka: 93 posisi manual user 07-27→08-15 (untung: pool umur ~19h, fee/TVL 1h ~1.1%, masuk bukan pas burst;
// rugi: umur ~6.5h, fee/TVL 1h ~3.2%, ditahan >6h, fee udah 75–98% di setengah pertama).

/** Filter entry. Balikin { ok, reasons[] } — reasons diisi alasan TOLAK (kosong = lolos). */
export function screen(p, d, x, cfg) {
  const r = [];
  const C = cfg.coin, L = cfg.liquidity, T = cfg.technical;
  // 1. coin
  if (!(p.mcap >= C.minMcap && p.mcap <= C.maxMcap)) r.push(`mcap ${fmt(p.mcap)}`);
  if (!(p.holders >= C.minHolders)) r.push(`holders ${p.holders}`);
  if (p.poolAgeH == null || p.poolAgeH < C.minPoolAgeH) r.push(`umur pool ${p.poolAgeH == null ? "?" : p.poolAgeH.toFixed(1) + "h"}`);
  if (x && (x.chg24h < C.minChg24h || x.chg24h > C.maxChg24h)) r.push(`chg24h ${x.chg24h}%`);
  if (!(p.baseFeePct >= C.baseFeeMin && p.baseFeePct <= C.baseFeeMax)) r.push(`base fee ${p.baseFeePct}%`);
  if (/USD|USDC|USDT|USDG/i.test(p.sym) && p.sym.length <= 6) r.push("stable/synthetic");
  // 2. liquidity
  if (!(p.tvl >= L.minTvl && p.tvl <= L.maxTvl)) r.push(`tvl $${fmt(p.tvl)}`);
  if (!(p.feeTvl24h >= L.minFeeTvl24h)) r.push(`fee/tvl 24h ${p.feeTvl24h.toFixed(1)}%`);
  if (!(p.fee24hSol >= L.minFee24hSol)) r.push(`fee 24h ${p.fee24hSol.toFixed(2)} SOL`);
  if (d) {
    if (d.feeTvl1h > L.maxFeeTvl1h) r.push(`BURST fee/tvl 1h ${d.feeTvl1h.toFixed(2)}%`);
    const avgHourVol = d.vol24h / 24;
    if (avgHourVol > 0 && d.vol1h > L.maxVol1hVsAvg * avgHourVol) r.push(`BURST vol 1h ${(d.vol1h / avgHourVol).toFixed(1)}× rata-rata`);
  }
  // 3. technical
  if (p.maxPrice24h > 0 && p.price > 0) {
    if (p.price > p.maxPrice24h * 1.0001) r.push("harga di atas puncak 24h");
    const dd = (1 - p.price / p.maxPrice24h) * 100;
    if (dd > T.maxDrawdownFromPeak) r.push(`drawdown dari puncak ${dd.toFixed(0)}%`);
  } else r.push("harga/puncak 24h ga ada");
  if (x && x.chg1h < T.minChg1h) r.push(`chg1h ${x.chg1h}%`);
  if (x && T.maxChg1h != null && x.chg1h > T.maxChg1h) r.push(`PUMP chg1h +${x.chg1h}%`); // dry 08-27..30: 4/4 entry pas pump 1h → fee 0
  return { ok: r.length === 0, reasons: r };
}

/** Jumlah bin bid-ask di bawah harga: kedalaman targetDepth (mis. 0.45 = −45%), clamp [minBins,maxBins]. */
export function binsFor(binStep, T) {
  if (!(binStep > 0)) return T.minBins;
  const n = Math.round(Math.log(1 / (1 - T.targetDepth)) / Math.log(1 + binStep / 1e4));
  return Math.max(T.minBins, Math.min(T.maxBins, n));
}

/** Size (SOL): tier by TVL × cap stage × cap %TVL × sisa capTotal. Balikin 0 kalau ga muat. */
export function sizeFor({ tvlUsd, solUsd, stage, deployedTotal }, cfg) {
  const tier = cfg.tiers.find((t) => tvlUsd <= t.maxTvl) || cfg.tiers.at(-1);
  const S = cfg.stages[String(stage)];
  if (!S) return 0;
  let s = Math.min(tier.sizeSol, S.capPerPool, (tvlUsd * cfg.liquidity.maxSizePctTvl / 100) / solUsd, S.capTotal - deployedTotal);
  s = Math.floor(s * 100) / 100;
  return s >= 0.3 ? s : 0;
}

/**
 * Keputusan exit. pos: { openedAt, deployedSol, slTicks, prevPnlPct, oorUpSince, feeHist:[{t,fee}] }
 * v: { valueSol, feesSol, oorUp } ; now: ms. Balikin { why, mutate } — mutate = perubahan state posisi.
 */
export function exitDecision(pos, v, now, E) {
  const heldMin = (now - new Date(pos.openedAt).getTime()) / 60e3;
  const pnlPct = (v.valueSol - pos.deployedSol) / pos.deployedSol * 100;
  const m = { lastPnlPct: +pnlPct.toFixed(2), lastValueSol: +v.valueSol.toFixed(4), prevPnlPct: pnlPct };
  // 1. cut loss: 2 tick, atau 1 tick kalau crash (drop ≥ fastSlDrop poin sejak tick lalu / udah ≤ sl−10)
  if (pnlPct <= E.slPct) {
    m.slTicks = (pos.slTicks || 0) + 1;
    const crash = (pos.prevPnlPct != null && pos.prevPnlPct - pnlPct >= E.fastSlDrop) || pnlPct <= E.slPct - 10;
    if (m.slTicks >= E.slTicks || crash) return { why: crash && m.slTicks < E.slTicks ? "SL-fast" : "SL", mutate: m };
  } else m.slTicks = 0;
  // 2. maxHold
  if (heldMin >= E.maxHoldH * 60) return { why: "maxHold", mutate: m };
  // 3. OOR atas (harga lari di atas range + band) selama oorUpMin → ambil untung
  m.oorUpSince = v.oorUp ? (pos.oorUpSince || now) : null;
  if (v.oorUp && now - m.oorUpSince >= E.oorUpMin * 60e3) return { why: "oor-up", mutate: m };
  // 4. party over: setelah partyOverAfterMin, fee windowMin terakhir < minShare × total fee
  const hist = [...(pos.feeHist || []), { t: now, fee: v.feesSol }].filter((h) => now - h.t <= E.maxHoldH * 3600e3);
  m.feeHist = hist;
  if (heldMin >= E.partyOverAfterMin && v.feesSol > 0) {
    const cutoff = now - E.partyOverWindowMin * 60e3;
    const before = hist.filter((h) => h.t <= cutoff);
    if (before.length) {
      const feeThen = before.at(-1).fee, recent = v.feesSol - feeThen;
      if (recent < E.partyOverMinShare * v.feesSol) return { why: "party-over", mutate: m, detail: `fee ${E.partyOverWindowMin}m terakhir ${(recent / v.feesSol * 100).toFixed(0)}% dari total` };
    }
  }
  return { why: null, mutate: m };
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(Math.round(n));

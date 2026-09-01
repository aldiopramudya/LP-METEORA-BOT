#!/usr/bin/env node
// BIDASK — bot LP Meteora DLMM, bid-ask single-side SOL, aturan dari gaya manual user (08-27).
// Prinsip: blockchain = kebenaran; state lokal cuma catatan. Tiap angka uang = delta saldo wallet.
// MODE dry: semua jalan (screening, keputusan, catatan) kecuali kirim tx — posisi disimulasikan dari harga pool.
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log, sleep, num, round, hoursSince, readEnv, readJson, writeJsonAtomic, appendJsonl, withTimeout } from "./lib/util.mjs";
import { Rpc } from "./lib/rpc.mjs";
import { Sdk } from "./lib/sdk.mjs";
import { Cli, failed } from "./lib/cli.mjs";
import { State } from "./lib/state.mjs";
import { Tg } from "./lib/tg.mjs";
import { discover, poolDetail, priceChange, solUsd } from "./lib/meteora.mjs";
import { screen, binsFor, sizeFor, exitDecision } from "./lib/rules.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const OPS = join(DIR, "..");
const CONF0 = readJson(join(DIR, "config.json"));
const A2_DIR = CONF0.handsDir;   // "tangan" (cli.js meridian) + .env wallet — folder terpisah per wallet
const WALLET = CONF0.wallet;
if (!A2_DIR || !WALLET) throw new Error("config.json butuh handsDir & wallet");
const F = { conf: join(DIR, "config.json"), state: join(DIR, "state.json"), results: join(DIR, "results.jsonl"), hb: join(DIR, "heartbeat.json"), journal: join(DIR, "journal.jsonl") };

let CONF = readJson(F.conf);
const rpc = new Rpc([readEnv(`${A2_DIR}/.env`, "RPC_URL"), readEnv(`${A2_DIR}/.env`, "RPC_URL_FALLBACK")], WALLET);
const sdk = new Sdk(A2_DIR, rpc, WALLET);
const cli = new Cli(A2_DIR);
const store = new State(F.state);
const tg = new Tg(readEnv(`${OPS}/.env`, "COMMANDS_BOT_TOKEN"), readEnv(`${OPS}/.env`, "NOTIFY_CHAT_ID"));
const LIVE = () => CONF.mode === "live";
const tag = () => (LIVE() ? "BIDASK" : "BIDASK-DRY");
const journal = (ev, o = {}) => appendJsonl(F.journal, { ts: new Date().toISOString(), ev, ...o });

// ── posisi: baca nilai (live via SDK, dry via simulasi harga) ────────────────
async function readPosition(o) {
  if (!o.dry) return sdk.read(o, CONF.technical.oorBandPct);
  // DRY: single-side SOL bid-ask di bawah harga. Harga turun ke range → SOL jadi token (tertimbang ke bawah), fee terkalibrasi.
  const d = await poolDetail(o.pool);
  const P = d.price, P0 = o.entryPrice, lo = P0 * (1 - o.depth);
  const conv = Math.max(0, Math.min(1, (P0 - P) / (P0 - lo)));           // porsi range yang udah kelewat
  const w = conv * conv;                                                  // bid-ask: likuiditas numpuk di bawah → konversi lambat di awal
  const Pavg = P0 - (P0 - Math.max(P, lo)) * 0.66;                        // harga beli rata-rata condong ke bawah
  const valueBase = o.deployedSol * (1 - w) + o.deployedSol * w * (P / Pavg);
  const feeRawPct = (o.feeRawPct || 0) + (d.feeTvl24h / 100) * (CONF.tickSeconds / 86400) * (P <= P0 && P >= lo ? 1 : 0) * 100;
  o.feeRawPct = feeRawPct;
  const feePct = Math.min(feeRawPct, 0.45 * Math.pow(feeRawPct, 0.46)); // kalibrasi 08-27
  const feesSol = o.deployedSol * feePct / 100;
  return { valueSol: valueBase + feesSol, amtX: w > 0 ? 1 : 0, amtY: o.deployedSol * (1 - w), feesSol, oorUp: P > P0 * (1 + CONF.technical.oorBandPct / 100), priceSolPerX: P, dry: true };
}

// ── close dengan eskalasi: normal → reconcile (account gone) → backfill registry + skip-swap ──
async function closePosition(st, key, o, why) {
  if (o.dry) { delete st.open[key]; return { success: true, dry: true, auto_swapped: true }; }
  o.closeFails = o.closeFails || 0;
  let res = await cli.close(o.position);
  if (failed(res)) { try { if (await rpc.accountGone(o.position)) res = { success: true, reconciled: "account gone" }; } catch {} }
  if (failed(res)) { await sleep(5000); try { if (await rpc.accountGone(o.position)) res = { success: true, reconciled: "account gone (retry 5s)" }; } catch {} } // 08-31 OTC: tx close landed, cek pertama kena lag
  if (failed(res) && o.closeFails >= 2) {
    try { cli.backfillRegistry(o); } catch (e) { log(`backfill err: ${e.message}`); }
    res = await cli.close(o.position, true); if (!failed(res)) res.skipSwap = true;
    if (failed(res)) { try { if (await rpc.accountGone(o.position)) res = { success: true, reconciled: "gone post-force" }; } catch {} }
  }
  if (!failed(res)) {
    if (o.mint && res.auto_swapped !== true) st.pendingSells[o.mint] = { sym: o.sym, since: Date.now(), tries: 0, why: res.skipSwap ? "skip-swap" : res.reconciled ? "reconciled" : "swap-gagal" };
    delete st.open[key]; sdk.forget(o.pool);
    if (o.closeFails >= 3 && !st.blacklist.includes(o.pool)) st.blacklist.push(o.pool);
    return res;
  }
  o.closeFails++;
  if (o.closeFails >= 3 && !st.blacklist.includes(o.pool)) st.blacklist.push(o.pool);
  if (o.closeFails === 3 || o.closeFails % 20 === 0) await tg.send(`🚨 ${tag()}: close ${o.sym} GAGAL ${o.closeFails}× — ${String(res.error).slice(0, 120)}. POSISI GA KE-MANAGE.`);
  return res;
}

async function realizedFromWallet(o, balBefore, res, est) {
  if (o.dry || balBefore == null || o.costSol == null) return { realized: est, basis: o.dry ? "dry" : "est" };
  await sleep(3000);
  const balAfter = await rpc.walletSol().catch(() => null);
  if (balAfter == null) return { realized: est, basis: "est" };
  const w = round(balAfter - balBefore - o.costSol);
  const tokenLeft = o.mint ? await rpc.tokenBal(o.mint).catch(() => 1) : 0;
  const sane = w >= -1.05 * o.deployedSol && w <= 1.0 * o.deployedSol;
  if (sane && (res.auto_swapped === true || tokenLeft === 0)) return { realized: w, basis: "wallet" };
  log(`realized wallet ${w} (auto_swapped=${res.auto_swapped}, tokenLeft=${tokenLeft}) ga dipakai — est ${est}`);
  return { realized: est, basis: "est" };
}

// ── manage posisi terbuka ────────────────────────────────────────────────────
async function manage(st) {
  const now = Date.now();
  for (const [key, o] of Object.entries(st.open)) {
    let v;
    try { v = await withTimeout(readPosition(o), 45000, `read ${o.sym}`); o.readFails = 0; rpc.noteRead(true); }
    catch (e) {
      o.readFails = (o.readFails || 0) + 1; sdk.forget(o.pool); rpc.noteRead(false, e);
      log(`read ${o.sym}: ${String(e.message).slice(0, 100)} (${o.readFails}x)`);
      if (o.readFails === 5 || o.readFails % 60 === 0) await tg.send(`🚨 ${tag()}: ${o.sym} ga kebaca ${o.readFails}× — POSISI BUTA`);
      continue;
    }
    if (v == null) { // ga ada di pool — konfirmasi account gone 3× sebelum vonis
      o.goneMisses = (o.goneMisses || 0) + 1;
      if (o.goneMisses >= 3 && (await rpc.accountGone(o.position).catch(() => false))) {
        log(`${o.sym}: account gone (ditutup di luar) — bersihin`); journal("gone-external", o);
        appendJsonl(F.results, { ts: new Date().toISOString(), sym: o.sym, why: "gone-external", pnlPct: o.lastPnlPct ?? null, realizedSol: null, basis: "gone", heldH: round(hoursSince(o.openedAt), 2), deployedSol: o.deployedSol, entry: o.entry, pool: o.pool, mode: o.dry ? "dry" : "live", note: "close landed tapi hasil cli hilang — cek wallet buat angka" });
        st.cooldowns[o.pool] = now + CONF.exit.cooldownH * 3600e3; if (o.mint) st.cooldowns[o.mint] = now + CONF.exit.cooldownH * 3600e3;
        if (o.mint) st.pendingSells[o.mint] = { sym: o.sym, since: now, tries: 0, why: "gone-external" };
        delete st.open[key];
      }
      continue;
    }
    o.goneMisses = 0;
    // deploy kosong (likuiditas ga landed): struktural, 30 menit pertama
    if (!o.dry && v.amtX === 0 && v.amtY === 0 && hoursSince(o.openedAt) < 0.5) {
      if ((o.emptyTicks = (o.emptyTicks || 0) + 1) >= 2) {
        log(`${o.sym}: posisi KOSONG — likuiditas ga landed, tutup tanpa SL`);
        const r = await closePosition(st, key, o, "empty");
        if (!failed(r)) { appendJsonl(F.results, { ts: new Date().toISOString(), sym: o.sym, why: "empty-deploy", pnlPct: 0, realizedSol: 0, basis: "empty", pool: o.pool }); await tg.send(`⚠️ ${tag()}: deploy ${o.sym} KOSONG — ditutup, rent balik, bukan SL.`); }
      }
      continue;
    }
    o.emptyTicks = 0;
    if (o.deployedSol == null) { o.deployedSol = round(v.valueSol); log(`${o.sym}: basis pnl diset dari nilai sekarang (boot-adopted)`); }
    if (!o.basisChecked) { // baca pertama: kalau CLI ngecilin size & posisi masih murni SOL → basis ikut nyata
      o.basisChecked = true;
      if (!o.dry && hoursSince(o.openedAt) < 0.1 && v.amtX === 0 && v.valueSol > 0 && Math.abs(v.valueSol - o.deployedSol) / o.deployedSol > 0.15) {
        log(`${o.sym}: nilai awal ${v.valueSol.toFixed(3)} ≠ size ${o.deployedSol} — basis diset nyata`);
        if (o.costSol != null) o.costSol = round(o.costSol - (o.deployedSol - v.valueSol)); o.deployedSol = round(v.valueSol);
      }
    }
    const dec = exitDecision(o, v, now, CONF.exit);
    Object.assign(o, dec.mutate);
    if (!dec.why) continue;

    log(`CLOSE ${o.sym} (${dec.why}${dec.detail ? ": " + dec.detail : ""}) pnl ${o.lastPnlPct}%`);
    const balBefore = o.dry ? null : await rpc.walletSol().catch(() => null);
    const res = await closePosition(st, key, o, dec.why);
    if (failed(res)) continue;
    const est = o.dry ? round(v.valueSol - o.deployedSol - 0.003 * (v.valueSol - v.amtY) - 0.002) : round(v.valueSol * 0.97 - o.deployedSol);
    const { realized, basis } = await realizedFromWallet(o, balBefore, res, est);
    st.day.realizedSol += realized;
    st.cooldowns[o.pool] = now + CONF.exit.cooldownH * 3600e3; // pool yang sama istirahat dulu, apa pun alasan keluarnya
    if (o.mint) st.cooldowns[o.mint] = now + CONF.exit.cooldownH * 3600e3; // dry 08-29: OTC masuk 2× di 2 pool dalam 1 jam → cooldown per KOIN juga
    const row = { ts: new Date().toISOString(), sym: o.sym, why: dec.why, pnlPct: o.lastPnlPct, realizedSol: round(realized), basis, heldH: round(hoursSince(o.openedAt), 2),
      feesSol: round(v.feesSol), deployedSol: o.deployedSol, bins: o.bins, entry: o.entry, pool: o.pool, mode: o.dry ? "dry" : "live" };
    appendJsonl(F.results, row);
    await tg.send(`${realized >= 0 ? "✅" : "🔻"} <b>${tag()} CLOSE</b> ${o.sym} (${dec.why}) · ${realized >= 0 ? "+" : ""}${realized.toFixed(3)} SOL${basis !== "wallet" ? ` (${basis})` : ""} · ${o.lastPnlPct}% · fee ${v.feesSol.toFixed(3)} · ${row.heldH}h`);
    const S = CONF.stages[String(CONF.stage)];
    if (!o.dry && S && st.day.realizedSol <= -S.dailyHaltSol && !st.halted) { st.halted = true; await tg.send(`🛑 <b>${tag()} HALT</b>: rugi hari ini ${st.day.realizedSol.toFixed(3)} SOL ≥ ${S.dailyHaltSol}. Entry stop sampai besok.`); }
  }
}

// ── token sisa & deploy tertunda & escrow ───────────────────────────────────
async function sellPending(st) {
  for (const [mint, ps] of Object.entries(st.pendingSells)) {
    if (ps.nextTry && Date.now() < ps.nextTry) continue;
    let bal; try { bal = await rpc.tokenBal(mint); } catch (e) { log(`pendingSell ${ps.sym}: ${e.message}`); continue; }
    if (bal <= 0) { delete st.pendingSells[mint]; continue; }
    ps.tries = (ps.tries || 0) + 1;
    const r = LIVE() ? await cli.swap(mint, bal) : { success: true, dry: true };
    if (r && r.success !== false && !r.error && (r.tx || r.amount_out || r.dry)) { log(`pendingSell ${ps.sym}: SOLD ${bal}`); await tg.send(`🧹 ${tag()}: sisa token ${ps.sym} kejual (${ps.why})`); delete st.pendingSells[mint]; }
    else { ps.nextTry = Date.now() + Math.min(30 * 60e3, 60e3 * 2 ** Math.min(ps.tries, 5)); log(`pendingSell ${ps.sym}: gagal ${ps.tries}x ${String(r?.error).slice(0, 80)}`);
      if (ps.tries === 3) await tg.send(`⚠️ ${tag()}: sisa token ${ps.sym} GA BISA dijual 3× — ${String(r?.error).slice(0, 100)}`);
      if (Date.now() - ps.since > 48 * 3600e3) delete st.pendingSells[mint]; }
  }
}
async function adoptLateDeploys(st) {
  for (const [pool, pd] of Object.entries(st.pendingDeploys)) {
    if (Date.now() > pd.until) { delete st.pendingDeploys[pool]; continue; }
    const after = await rpc.chainPositions().catch(() => null); if (!after) return;
    const landed = after.find((c) => c.pool === pool && !pd.before.includes(c.position) && !Object.values(st.open).some((o) => o.position === c.position));
    if (landed) {
      st.open[`${pool}:${Date.now()}`] = { ...pd.pos, position: landed.position, costSol: null, openedAt: new Date().toISOString(), lateLanded: true };
      delete st.pendingDeploys[pool]; store.save(st);
      log(`ADOPT ${pd.pos.sym}: deploy "gagal" ternyata landed — ${landed.position.slice(0, 8)}`); journal("adopt", { sym: pd.pos.sym, position: landed.position });
      await tg.send(`⚠️ ${tag()}: deploy ${pd.pos.sym} yang tadi "gagal" ternyata LANDED — diadopsi.\n<code>${landed.position}</code>`);
    }
  }
}
let lastEscrow = 0;
async function escrowGuard() {
  if (Date.now() - lastEscrow < 3600e3) return; lastEscrow = Date.now();
  try {
    const r = await fetch(`https://lite-api.jup.ag/trigger/v1/getTriggerOrders?user=${WALLET}&orderStatus=active`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) }).then((x) => x.json());
    const n = (r?.orders || []).length; if (!n) return;
    log(`ESCROW: ${n} order Jupiter nyangkut — rescue`);
    await cli.runScript("tools/rescue-limit-orders.mjs", 240000);
    await tg.send(`🧹 ${tag()}: ${n} limit order Jupiter nyangkut → rescue dijalankan`);
  } catch (e) { log(`escrowGuard: ${e.message}`); }
}

// ── screening + entry ───────────────────────────────────────────────────────
async function screenAndEnter(st) {
  const now = Date.now();
  if (now - st.lastScreen < CONF.screenMinutes * 60e3) return;
  st.lastScreen = now; store.save(st);
  if (st.halted) { log("HALTED — entry stop"); return; }
  const openN = Object.keys(st.open).length;
  if (openN >= CONF.maxPools) return;
  if (now - st.lastEntry < CONF.entryGapMinutes * 60e3) return;
  const px = await solUsd(CONF.solUsdFallback);
  const deployedTotal = Object.values(st.open).reduce((a, o) => a + (o.deployedSol || 0), 0);
  let pools; try { pools = await discover(CONF.liquidity.minTvl); } catch (e) { log(`discover: ${e.message}`); return; }
  const heldPools = new Set(Object.values(st.open).map((o) => o.pool)), heldMints = new Set(Object.values(st.open).map((o) => o.mint));
  let checked = 0, rejected = {};
  for (const p of pools) {
    if (heldPools.has(p.pool) || heldMints.has(p.mint) || st.blacklist.includes(p.pool)) continue;
    if (st.cooldowns[p.pool] > now || st.cooldowns[p.mint] > now || st.pendingDeploys[p.pool]) continue;
    p.fee24hSol = p.fee24hUsd / px;
    const pre = screen(p, null, null, CONF); // tahap 1: data list doang (murah)
    if (!pre.ok) { rejected[pre.reasons[0].split(" ")[0]] = (rejected[pre.reasons[0].split(" ")[0]] || 0) + 1; continue; }
    if (++checked > 12) break;
    let d = null, x = null;
    try { [d, x] = await Promise.all([poolDetail(p.pool), priceChange(p.pool)]); } catch (e) { log(`detail ${p.sym}: ${e.message}`); continue; }
    if (x == null) { log(`${p.sym}: dexscreener kosong — skip`); continue; }
    const r = screen(p, d, x, CONF);
    if (!r.ok) { log(`skip ${p.sym}: ${r.reasons.join("; ")}`); continue; }
    const size = sizeFor({ tvlUsd: p.tvl, solUsd: px, stage: CONF.stage, deployedTotal }, CONF);
    if (!size) { log(`skip ${p.sym}: size 0 (cap stage/total)`); continue; }
    const bins = binsFor(p.binStep, CONF.technical);
    const entry = { mcap: Math.round(p.mcap), tvl: Math.round(p.tvl), feeTvl24h: round(p.feeTvl24h, 1), feeTvl1h: round(d.feeTvl1h, 2), vol1hX: round(d.vol1h / (d.vol24h / 24 || 1), 1), poolAgeH: round(p.poolAgeH, 1), holders: p.holders, chg1h: x.chg1h, chg24h: x.chg24h, ddPeak: round((1 - p.price / p.maxPrice24h) * 100, 1), binStep: p.binStep, organic: round(p.organic, 0) };
    const base = { sym: p.sym, pool: p.pool, mint: p.mint, deployedSol: size, bins, depth: 1 - Math.pow(1 + p.binStep / 1e4, -bins), entry, entryPrice: p.price };
    journal("screen", { pools: pools.length, checked, rejected, picked: p.sym });
    if (!LIVE()) {
      st.open[`${p.pool}:${now}`] = { ...base, dry: true, position: `dry:${p.pool.slice(0, 8)}`, openedAt: new Date().toISOString(), costSol: null };
      st.lastEntry = now; store.save(st);
      log(`[DRY] DEPLOY ${p.sym} ${size} SOL · ${bins} bins bid-ask @ step ${p.binStep} · tvl $${(p.tvl / 1e3).toFixed(0)}k · mcap $${(p.mcap / 1e6).toFixed(2)}M · fee/tvl 1h ${d.feeTvl1h.toFixed(2)}%`);
      await tg.send(`🧪 <b>BIDASK-DRY DEPLOY</b> ${p.sym} · ${size} SOL · ${bins} bins · tvl $${(p.tvl / 1e3).toFixed(0)}k · umur ${p.poolAgeH.toFixed(0)}h · fee/tvl 1h ${d.feeTvl1h.toFixed(2)}%`);
      return;
    }
    // LIVE
    let free; try { free = await rpc.walletSol(); } catch { return; }
    const rent = 0.06 * Math.ceil(bins / 70) * 2;
    if (free < size + CONF.reserveSol + rent) { log(`skip ${p.sym}: saldo ${free.toFixed(2)} < ${size}+reserve`); return; }
    log(`DEPLOY ${p.sym} ${size} SOL · ${bins} bins bid-ask @ step ${p.binStep}`);
    const before = (await rpc.chainPositions().catch(() => [])).map((c) => c.position);
    const balBefore = await rpc.walletSol().catch(() => null);
    const res = await cli.deploy(p.pool, bins, size);
    let position = res?.success ? res.position : null;
    if (!position) {
      await sleep(8000);
      const after = await rpc.chainPositions().catch(() => []);
      const landed = after.find((c) => c.pool === p.pool && !before.includes(c.position));
      if (landed) { position = landed.position; log(`deploy "gagal" tapi LANDED — diadopsi`); }
    }
    if (!position) {
      log(`deploy ${p.sym} gagal: ${String(res?.error).slice(0, 120)}`); journal("deploy-fail", { sym: p.sym, error: res?.error });
      if (!/cooldown|blocked|Insufficient|saldo|duplicate|Invalid/i.test(String(res?.error))) st.pendingDeploys[p.pool] = { before, until: now + 15 * 60e3, pos: base };
      return;
    }
    await sleep(3000);
    const balAfter = await rpc.walletSol().catch(() => null);
    let costSol = balBefore != null && balAfter != null ? round(balBefore - balAfter) : null;
    if (costSol != null && (costSol < size * 0.9 || costSol > size + 1)) { log(`costSol ${costSol} ga masuk akal — est`); costSol = null; }
    st.open[`${p.pool}:${now}`] = { ...base, bins: res.binsUsed || bins, position, costSol, openedAt: new Date().toISOString() };
    st.lastEntry = now; store.save(st);
    journal("deploy", { sym: p.sym, size, bins: res.binsUsed || bins, position, costSol });
    await tg.send(`🚀 <b>BIDASK DEPLOY</b> ${p.sym} · ${size} SOL · ${res.binsUsed || bins} bins bid-ask @ step ${p.binStep} · tvl $${(p.tvl / 1e3).toFixed(0)}k · umur ${p.poolAgeH.toFixed(0)}h\n<code>${position}</code>`);
    return; // 1 entry per screening
  }
  if (checked === 0 && pools.length) log(`screen: ${pools.length} pool, 0 lolos pra-filter (${Object.entries(rejected).map(([k, v]) => k + ":" + v).join(", ")})`);
  journal("screen", { pools: pools.length, checked, rejected });
}

// ── laporan harian 09:00 WIB (02:00 UTC) + pengingat hari ke-3 dry ───────────
const DRY_START = "2026-08-27"; const DRY_DAYS = 3;
async function dailyReport(st) {
  const now = new Date(); const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 2 || st.lastReport === today) return;
  st.lastReport = today; store.save(st);
  const rows = (() => { try { return readFileSync(F.results, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const y = new Date(now.getTime() - 864e5).toISOString().slice(0, 10);
  const d = rows.filter((r) => r.ts.startsWith(y));
  const jr = (() => { try { return readFileSync(F.journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ts.startsWith(y)); } catch { return []; } })();
  const why = {}; for (const r of d) why[r.why] = (why[r.why] || 0) + 1;
  const dayN = Math.round((Date.parse(today) - Date.parse(DRY_START)) / 864e5);
  let msg = `📋 <b>${tag()} laporan ${y}</b> (hari ${dayN}/${DRY_DAYS} dry)\n` +
    `close: ${d.length} · ${Object.entries(why).map(([k, v]) => k + " " + v).join(", ") || "-"}\n` +
    `pnl simulasi: ${d.reduce((a, r) => a + (r.realizedSol || 0), 0).toFixed(3)} SOL · posisi open: ${Object.keys(st.open).length}\n` +
    `deploy gagal: ${jr.filter((r) => r.ev === "deploy-fail").length} · error tick: cek log`;
  if (!LIVE() && dayN >= DRY_DAYS) msg += `\n\n⏰ <b>3 HARI DRY SELESAI.</b> Waktunya keputusan tahap 1 (0.5 SOL/pool). Minta Claude rekap dulu, lalu bilang "live".`;
  await tg.send(msg);
}
// ── tick ────────────────────────────────────────────────────────────────────
async function tick() {
  CONF = readJson(F.conf, CONF);
  const st = store.load();
  writeJsonAtomic(F.hb, { ts: Date.now(), mode: CONF.mode, stage: CONF.stage, open: Object.keys(st.open).length });
  const today = new Date().toISOString().slice(0, 10);
  if (st.day.date !== today) { st.day = { date: today, realizedSol: 0 }; st.halted = false; }
  await manage(st);
  store.save(st); // bookkeeping posisi tersimpan DULU, sebelum apa pun yang bisa throw
  await sellPending(st).catch((e) => log(`sellPending: ${e.message}`));
  await adoptLateDeploys(st).catch((e) => log(`adoptLate: ${e.message}`));
  await escrowGuard();
  await screenAndEnter(st).catch((e) => log(`screen: ${String(e.message).slice(0, 150)}`));
  await dailyReport(st).catch((e) => log(`report: ${e.message}`));
  for (const [k, until] of Object.entries(st.cooldowns)) if (until < Date.now()) delete st.cooldowns[k];
  store.save(st);
}

// ── boot ────────────────────────────────────────────────────────────────────
log(`${tag()} start — stage ${CONF.stage} · maxPools ${CONF.maxPools} · SL ${CONF.exit.slPct}% · maxHold ${CONF.exit.maxHoldH}h · party-over ${CONF.exit.partyOverWindowMin}m<${CONF.exit.partyOverMinShare * 100}%`);
await sdk.init(); log("SDK siap");
try { // rekonsiliasi boot: chain = kebenaran (hanya posisi live)
  const st = store.load(); const chain = await rpc.chainPositions(); let changed = false;
  const known = new Set(Object.values(st.open).map((o) => o.position));
  for (const c of chain) {
    if (known.has(c.position)) continue;
    // posisi wb-live lama juga ada di wallet ini — jangan diadopsi kalau wb-live masih ngelola
    const wb = readJson(`${OPS}/wb-live-state.json`, { open: {} });
    if (Object.values(wb.open || {}).some((o) => o.position === c.position)) continue;
    st.open[`boot:${c.position}`] = { sym: `BOOT-${c.position.slice(0, 6)}`, pool: c.pool, mint: null, position: c.position, deployedSol: null, openedAt: new Date().toISOString(), bootAdopted: true };
    changed = true; await tg.send(`⚠️ ${tag()} BOOT: posisi on-chain tak dikenal — diadopsi.\n<code>${c.position}</code>`);
  }
  for (const [k, o] of Object.entries(st.open)) {
    if (o.dry || o.bootAdopted || chain.length === 0) continue;
    if (!chain.some((c) => c.position === o.position) && (await rpc.accountGone(o.position).catch(() => false))) {
      await tg.send(`⚠️ ${tag()} BOOT: ${o.sym} di state tapi account gone — dibersihin.`);
      if (o.mint) st.pendingSells[o.mint] = { sym: o.sym, since: Date.now(), tries: 0, why: "boot-gone" };
      delete st.open[k]; changed = true;
    }
  }
  if (changed) store.save(st);
} catch (e) { log(`boot reconcile: ${e.message}`); }

let busy = false;
const run = async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { log(`tick err: ${String(e.stack || e.message).slice(0, 300)}`); } finally { busy = false; } };
setInterval(run, CONF.tickSeconds * 1000);
run();

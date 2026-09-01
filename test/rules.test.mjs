import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { screen, binsFor, sizeFor, exitDecision } from "../lib/rules.mjs";
const cfg = (() => { for (const f of ["../config.json", "../config.example.json"]) { try { return JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")); } catch {} } throw new Error("no config"); })();
const good = { sym: "OK", mcap: 1.2e6, holders: 4500, poolAgeH: 19, baseFeePct: 2, tvl: 35000, feeTvl24h: 15, fee24hSol: 5, price: 0.9, maxPrice24h: 1.0 };
const goodD = { feeTvl1h: 1.1, vol1h: 23000, vol24h: 212000 };
const goodX = { chg1h: 2, chg24h: 20 };

test("screen: posisi untung tipikal user lolos", () => { assert.deepEqual(screen(good, goodD, goodX, cfg), { ok: true, reasons: [] }); });
test("screen: pool muda + burst (profil rugi) ditolak dgn alasan jelas", () => {
  const r = screen({ ...good, poolAgeH: 6.5 }, { feeTvl1h: 3.2, vol1h: 65000, vol24h: 254000 }, goodX, cfg);
  assert.equal(r.ok, false); assert.ok(r.reasons.some((x) => x.startsWith("umur pool"))); assert.ok(r.reasons.filter((x) => x.startsWith("BURST")).length === 2);
});
test("screen: mcap/holders/fee24h/tvl batas", () => {
  assert.ok(!screen({ ...good, mcap: 240000 }, goodD, goodX, cfg).ok);
  assert.ok(!screen({ ...good, holders: 1999 }, goodD, goodX, cfg).ok);
  assert.ok(!screen({ ...good, fee24hSol: 2.9 }, goodD, goodX, cfg).ok);
  assert.ok(!screen({ ...good, tvl: 19999 }, goodD, goodX, cfg).ok);
  assert.ok(!screen({ ...good, tvl: 100001 }, goodD, goodX, cfg).ok);
});
test("screen: harga di atas puncak / drawdown >30% / chg1h < -10 ditolak", () => {
  assert.ok(!screen({ ...good, price: 1.01 }, goodD, goodX, cfg).ok);
  assert.ok(!screen({ ...good, price: 0.69 }, goodD, goodX, cfg).ok);
  assert.ok(!screen(good, goodD, { chg1h: -11, chg24h: 0 }, cfg).ok);
  assert.ok(!screen(good, goodD, { chg1h: 0, chg24h: -31 }, cfg).ok);
  assert.ok(!screen(good, goodD, { chg1h: 16, chg24h: 0 }, cfg).ok);  // pump 1h ditolak
  assert.ok(screen(good, goodD, { chg1h: 14, chg24h: 0 }, cfg).ok);
});
test("binsFor: step 100 → ~60, clamp 40..80", () => {
  assert.equal(binsFor(100, cfg.technical), 60); assert.equal(binsFor(20, cfg.technical), 80); assert.equal(binsFor(400, cfg.technical), 40);
});
test("sizeFor: tier TVL × cap stage × 1.5% TVL × sisa total", () => {
  assert.equal(sizeFor({ tvlUsd: 30000, solUsd: 100, stage: 3, deployedTotal: 0 }, cfg), 0.5);
  assert.equal(sizeFor({ tvlUsd: 50000, solUsd: 100, stage: 3, deployedTotal: 0 }, cfg), 1.0);
  assert.equal(sizeFor({ tvlUsd: 80000, solUsd: 100, stage: 3, deployedTotal: 0 }, cfg), 2.0);
  assert.equal(sizeFor({ tvlUsd: 20000, solUsd: 1000, stage: 3, deployedTotal: 0 }, cfg), 0.3); // 1.5%×20k/$1000 = 0.3 — cap %TVL ngiket
  assert.equal(sizeFor({ tvlUsd: 250000, solUsd: 100, stage: 3, deployedTotal: 0 }, cfg), 3.0);
  assert.equal(sizeFor({ tvlUsd: 250000, solUsd: 100, stage: 1, deployedTotal: 0 }, cfg), 0.5);
  assert.equal(sizeFor({ tvlUsd: 250000, solUsd: 100, stage: 1, deployedTotal: 0.8 }, cfg), 0);  // sisa 0.2 < 0.3 min
});
const E = cfg.exit; const t0 = Date.parse("2026-08-27T00:00:00Z");
const pos = (o = {}) => ({ openedAt: new Date(t0).toISOString(), deployedSol: 1, slTicks: 0, prevPnlPct: null, oorUpSince: null, feeHist: [], ...o });
test("exit: SL butuh 2 tick, crash 1 tick", () => {
  const a = exitDecision(pos(), { valueSol: 0.84, feesSol: 0, oorUp: false }, t0 + 60e3, E); assert.equal(a.why, null); assert.equal(a.mutate.slTicks, 1);
  const b = exitDecision(pos({ slTicks: 1, prevPnlPct: -16 }), { valueSol: 0.84, feesSol: 0, oorUp: false }, t0 + 90e3, E); assert.equal(b.why, "SL");
  const c = exitDecision(pos({ prevPnlPct: -2 }), { valueSol: 0.80, feesSol: 0, oorUp: false }, t0 + 60e3, E); assert.equal(c.why, "SL-fast");
  const d = exitDecision(pos(), { valueSol: 0.70, feesSol: 0, oorUp: false }, t0 + 60e3, E); assert.equal(d.why, "SL-fast"); // ≤ -25
});
test("exit: maxHold 6h, oor-up 15m", () => {
  assert.equal(exitDecision(pos(), { valueSol: 1, feesSol: 0.01, oorUp: false }, t0 + 6 * 3600e3, E).why, "maxHold");
  const a = exitDecision(pos(), { valueSol: 1, feesSol: 0, oorUp: true }, t0 + 60e3, E); assert.equal(a.why, null); assert.equal(a.mutate.oorUpSince, t0 + 60e3);
  assert.equal(exitDecision(pos({ oorUpSince: t0 + 60e3 }), { valueSol: 1, feesSol: 0, oorUp: true }, t0 + 16 * 60e3 + 60e3, E).why, "oor-up");
  assert.equal(exitDecision(pos({ oorUpSince: t0 + 60e3 }), { valueSol: 1, feesSol: 0, oorUp: false }, t0 + 20 * 60e3, E).mutate.oorUpSince, null);
});
test("exit: party-over — fee mandek setelah 60m; fee masih tumbuh = tahan", () => {
  const hist = [{ t: t0 + 20 * 60e3, fee: 0.05 }, { t: t0 + 40 * 60e3, fee: 0.098 }, { t: t0 + 50 * 60e3, fee: 0.099 }];
  const a = exitDecision(pos({ feeHist: hist }), { valueSol: 1.02, feesSol: 0.10, oorUp: false }, t0 + 80 * 60e3, E);
  assert.equal(a.why, "party-over");
  const b = exitDecision(pos({ feeHist: hist }), { valueSol: 1.02, feesSol: 0.15, oorUp: false }, t0 + 80 * 60e3, E);
  assert.equal(b.why, null); // 0.15-0.098 = 0.052 = 35% > 10%
  const c = exitDecision(pos({ feeHist: hist }), { valueSol: 1.02, feesSol: 0.10, oorUp: false }, t0 + 55 * 60e3, E);
  assert.equal(c.why, null); // belum 60 menit
});

/**
 * F2 — liquidation state-machine tests.
 *
 * Pure and deterministic: no RPC, no network, no funds.
 *
 * The regression anchor is the old executor rule
 *   `if (!token || token.usd < 0.10) return { swapped: attempt > 1 }`
 * which (a) reported a successful sale for a balance it never touched and (b) treated a
 * MISSING price as dust, because `null < 0.10` is true in JS. Dust is not sold. Zero is
 * not dust. An unknown price is not dust.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTION,
  DEFAULT_DUST_FLOOR_ATOMIC,
  DEFAULT_DUST_FLOOR_USD,
  STATUS,
  classifyLiquidation,
  dustEntry,
  isEconomicallySwappable,
  priceKnown,
  shouldRetry,
} from "../hands/tools/liquidation-status.js";

const B = (n) => BigInt(n);

// ─────────────────────────── case 1: zero balance ───────────────────────────

test("F2: an exactly-zero balance is ZERO → cleanup, never 'sold'", () => {
  const r = classifyLiquidation({ balanceAtomic: 0, usdValue: 0 });
  assert.equal(r.status, STATUS.ZERO);
  assert.equal(r.action, ACTION.CLEANUP);
  assert.equal(shouldRetry(r.status), false);
});

test("F2: a zero balance is not dust and not a sale", () => {
  const r = classifyLiquidation({ balanceAtomic: 0, usdValue: null });
  assert.notEqual(r.status, STATUS.DUST);
  assert.notEqual(r.status, STATUS.SOLD);
});

// ─────────────────────────── case 3: dust ───────────────────────────

test("F2: a sub-threshold USD balance is DUST and is never reported as sold", () => {
  const r = classifyLiquidation({ balanceAtomic: 500, usdValue: 0.02 });
  assert.equal(r.status, STATUS.DUST);
  assert.equal(r.action, ACTION.RECORD_DUST);
  assert.equal(r.sellable, false);
  assert.equal(shouldRetry(r.status), false, "dust must not enter a retry loop");
});

test("F2 REGRESSION: an unknown price with a real balance is NOT dust", () => {
  // The old code read `token.usd < 0.10` with usd === null and got true.
  const r = classifyLiquidation({ balanceAtomic: 152_579_116, usdValue: null });
  assert.notEqual(r.status, STATUS.DUST);
  assert.equal(r.status, STATUS.RETRY);
  assert.equal(r.action, ACTION.SWAP);
});

test("F2: an unknown price with integer dust is still recognised as dust", () => {
  const r = classifyLiquidation({ balanceAtomic: 3, usdValue: null });
  assert.equal(r.status, STATUS.DUST);
});

test("F2: `priceKnown` distinguishes a real zero valuation from a missing one", () => {
  assert.equal(priceKnown(0), true);
  assert.equal(priceKnown("0"), true);
  assert.equal(priceKnown(null), false);
  assert.equal(priceKnown(undefined), false);
  assert.equal(priceKnown(""), false);
  assert.equal(priceKnown("abc"), false);
});

test("F2: a genuinely worthless-priced balance is dust", () => {
  const r = classifyLiquidation({ balanceAtomic: 10_000_000, usdValue: 0 });
  assert.equal(r.status, STATUS.DUST);
});

test("F2: isEconomicallySwappable is explicit about both floors", () => {
  assert.equal(isEconomicallySwappable({ balanceAtomic: 0, usdValue: 5 }), false);
  assert.equal(isEconomicallySwappable({ balanceAtomic: 1000, usdValue: 0.05 }), false);
  assert.equal(isEconomicallySwappable({ balanceAtomic: 1000, usdValue: 1 }), true);
  // unknown price → atomic floor decides
  assert.equal(isEconomicallySwappable({ balanceAtomic: DEFAULT_DUST_FLOOR_ATOMIC + 1, usdValue: null }), true);
  assert.equal(isEconomicallySwappable({ balanceAtomic: 1, usdValue: null }), false);
  assert.equal(DEFAULT_DUST_FLOOR_USD, 0.10);
});

// ─────────────────────────── case 2: sellable ───────────────────────────

test("F2: a normal sellable balance is SWAP", () => {
  const r = classifyLiquidation({ balanceAtomic: 152_579_116, usdValue: 12.5 });
  assert.equal(r.action, ACTION.SWAP);
  assert.equal(r.sellable, true);
  assert.equal(shouldRetry(r.status), true);
});

// ─────────────────────── failures and bounded retries ───────────────────────

test("F2: a failed swap with attempts left is RETRY", () => {
  const r = classifyLiquidation({
    balanceAtomic: 1_000_000, usdValue: 5,
    swapAttempted: true, swapOk: false, swapError: "no route",
    attempts: 1, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.RETRY);
  assert.equal(shouldRetry(r.status), true);
  assert.match(r.reason, /no route/);
});

test("F2: a failed swap with retries exhausted is FAILED and stops retrying", () => {
  const r = classifyLiquidation({
    balanceAtomic: 1_000_000, usdValue: 5,
    swapAttempted: true, swapOk: false, swapError: "no route",
    attempts: 3, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.FAILED);
  assert.equal(r.action, ACTION.GIVE_UP);
  assert.equal(shouldRetry(r.status), false);
});

test("F2: a swap rejected by the F3 gate is failure-shaped, not dust", () => {
  const r = classifyLiquidation({
    balanceAtomic: 152_579_116, usdValue: 3,
    swapAttempted: true, swapOk: false, swapError: "UNEXPECTED_SOL_DEBIT",
    attempts: 4, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.FAILED);
  assert.notEqual(r.status, STATUS.DUST, "a blocked route must not be silently re-labelled as dust");
});

// ──────────────────── success is decided by the re-read ────────────────────

test("F2: a swap that leaves exactly zero is SOLD → cleanup", () => {
  const r = classifyLiquidation({
    balanceAtomic: 152_579_116, usdValue: 3,
    swapAttempted: true, swapOk: true, postBalanceAtomic: 0,
    attempts: 1, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.SOLD);
  assert.equal(r.action, ACTION.CLEANUP);
});

test("F2: a swap that leaves spendable dust is DUST, not SOLD", () => {
  const r = classifyLiquidation({
    balanceAtomic: 152_579_116, usdValue: 3,
    swapAttempted: true, swapOk: true, postBalanceAtomic: 4,
    attempts: 1, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.DUST);
  assert.equal(r.action, ACTION.RECORD_DUST);
  assert.match(r.reason, /residual dust/);
  assert.equal(shouldRetry(r.status), false);
});

test("F2: a swap reported as successful but with an unreadable post-balance stays RETRY", () => {
  // Never conclude "sold" from a stale or missing read.
  const r = classifyLiquidation({
    balanceAtomic: 152_579_116, usdValue: 3,
    swapAttempted: true, swapOk: true, postBalanceAtomic: null,
    attempts: 1, maxAttempts: 3,
  });
  assert.equal(r.status, STATUS.RETRY);
  assert.match(r.reason, /could not be re-read/);
});

test("F2: a swap leaving a meaningful residual retries, then gives up", () => {
  const mid = classifyLiquidation({
    balanceAtomic: 10_000_000, usdValue: 5,
    swapAttempted: true, swapOk: true, postBalanceAtomic: 4_000_000,
    attempts: 1, maxAttempts: 3,
  });
  assert.equal(mid.status, STATUS.RETRY);

  const last = classifyLiquidation({
    balanceAtomic: 10_000_000, usdValue: 5,
    swapAttempted: true, swapOk: true, postBalanceAtomic: 4_000_000,
    attempts: 3, maxAttempts: 3,
  });
  assert.equal(last.status, STATUS.FAILED);
  assert.equal(shouldRetry(last.status), false);
});

// ─────────────────────────── dust registry entry ───────────────────────────

test("F2: a dust entry records why the mint is still nonzero", () => {
  const e = dustEntry({ mint: "MINT", symbol: "DUST", balanceAtomic: 42, decimals: 6, usdValue: null, now: 0 });
  assert.equal(e.mint, "MINT");
  assert.equal(e.balance_atomic, "42");
  assert.equal(e.usd, null);              // unknown price stays unknown
  assert.match(e.reason, /uneconomic/);
  assert.equal(typeof e.since, "string");
});

// ─────────────────────────── dust registry (I/O) ───────────────────────────

test("F2: the dust registry records, reads, clears and summarises without a chain", async () => {
  const prevLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error"; // keep the test output clean
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dust-"));
  process.env.DUST_REGISTRY_FILE = path.join(dir, "dust-registry.json");
  const reg = await import("../hands/tools/dust-registry.js");

  assert.deepEqual(reg.dustMints(), []);
  reg.recordDust({ mint: "M1", symbol: "AA", balanceAtomic: 7, usdValue: null, reason: "too small" });
  reg.recordDust({ mint: "M2", symbol: "BB", balanceAtomic: 9, usdValue: 0.01 });
  assert.equal(reg.dustMints().length, 2);
  assert.equal(reg.getDust("M1").reason, "too small");
  assert.equal(reg.getDust("M2").reason, "uneconomic to swap");
  assert.equal(reg.listDust().length, 2);

  // re-recording refreshes rather than duplicates, and counts observations
  reg.recordDust({ mint: "M1", symbol: "AA", balanceAtomic: 8 });
  assert.equal(reg.dustMints().length, 2);
  assert.equal(reg.getDust("M1").observations, 2);

  const s = reg.summarizeDust();
  assert.equal(s.mints, 2);
  assert.equal(s.price_unknown, 1);

  reg.clearDust("M1", "sold");
  assert.deepEqual(reg.dustMints(), ["M2"]);

  // a corrupt registry is not fatal (informational only)
  fs.writeFileSync(process.env.DUST_REGISTRY_FILE, "{not json");
  assert.deepEqual(reg.dustMints(), []);

  delete process.env.DUST_REGISTRY_FILE;
  if (prevLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prevLevel;
});

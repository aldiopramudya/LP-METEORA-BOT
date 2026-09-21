import test from "node:test";
import assert from "node:assert/strict";
import {
  dlmmLiquidityState,
  isExpiredCloseError,
  processPositionClose,
  sendCloseWithLiquidityRecheck,
  settleCloseAccounting,
} from "../lib/close-safety.mjs";
import { sendDlmmCloseTransaction } from "../hands/tools/dlmm-close.js";

const position = (...liquidity) => ({
  positionData: { positionBinData: liquidity.map((positionLiquidity) => ({ positionLiquidity })) },
});

test("double-close: expired/block-height errors require an on-chain liquidity re-read", () => {
  assert.equal(isExpiredCloseError(new Error("TransactionExpiredBlockheightExceededError")), true);
  assert.equal(isExpiredCloseError(new Error("block height exceeded")), true);
  assert.equal(isExpiredCloseError(new Error("custom program error: 0x1")), false);
  assert.equal(dlmmLiquidityState(position("0", 0)), "zero");
  assert.equal(dlmmLiquidityState(position("0", "12")), "positive");
  assert.equal(dlmmLiquidityState(null), "unknown");
});

test("production DLMM close sender: expired close with zero LP liquidity is landed/partial", async () => {
  const error = new Error("Transaction was not confirmed before block height exceeded");
  let reads = 0;
  let partial = false;
  const signature = await sendDlmmCloseTransaction({
    connection: {},
    tx: {},
    wallet: {},
    pool: { getPosition: async () => { reads++; return position("0", "0"); } },
    positionPubKey: {},
    sendTransaction: async () => { throw error; },
    onPartial: () => { partial = true; },
  });
  assert.equal(signature, null);
  assert.equal(partial, true);
  assert.equal(reads, 1, "an expired confirmation must trigger a fresh position read");

  await assert.rejects(
    sendDlmmCloseTransaction({
      connection: {}, tx: {}, wallet: {}, positionPubKey: {},
      pool: { getPosition: async () => position("1") },
      sendTransaction: async () => { throw error; },
    }),
    (thrown) => thrown === error,
    "liquidity still present must retain the original transaction failure",
  );
});

test("double-close regression: non-expiry failures are never converted to partial success", async () => {
  const error = new Error("custom program error: 0x1");
  let reads = 0;
  await assert.rejects(
    sendCloseWithLiquidityRecheck({
      send: async () => { throw error; },
      readPosition: async () => { reads++; return position("0"); },
    }),
    (thrown) => thrown === error,
  );
  assert.equal(reads, 0);
});

test("production BIDASK close path: retry preserves baseline and zero liquidity bypasses exitDecision", async () => {
  const live = { valueSol: 0, amtX: 0, amtY: 0, feesSol: 0, oorUp: false };
  const open = { deployedSol: 1 };
  let persistSnapshot;
  let attempts = 0;

  const first = await processPositionClose({
    position: open, live,
    decide: () => ({ why: "SL", mutate: {} }),
    readWallet: async () => 10.5,
    persist: () => { persistSnapshot = structuredClone(open); },
    close: async () => { attempts++; return { error: "confirmation expired" }; },
    isFailed: (result) => Boolean(result.error),
    account: async () => assert.fail("failed attempt must not be accounted"),
  });
  assert.equal(first.closed, false);
  assert.deepEqual(persistSnapshot.closing, { reason: "SL", walletBefore: 10.5 });

  let decisions = 0;
  let accounted;
  const retry = await processPositionClose({
    position: open, live,
    decide: () => { decisions++; return { why: "SL-fast", mutate: {} }; },
    readWallet: async () => assert.fail("retry must not replace the wallet baseline"),
    persist: () => assert.fail("persist is only needed when the attempt begins"),
    close: async (reason) => { attempts++; assert.equal(reason, "SL"); return { success: true }; },
    isFailed: (result) => Boolean(result.error),
    account: async (values) => { accounted = values; },
  });
  assert.equal(retry.closed, true);
  assert.equal(decisions, 0, "an in-progress close must bypass exitDecision");
  assert.equal(attempts, 2);
  assert.equal(accounted.walletBefore, 10.5);
  assert.equal(accounted.reason, "SL");
});

test("production BIDASK accounting: estimated fallback PnL never contributes to daily HALT", async () => {
  const day = { realizedSol: -0.2 };
  const accounted = await settleCloseAccounting({
    day,
    position: { dry: false, deployedSol: 1, costSol: 0.01, mint: "mint" },
    live: { valueSol: 0.1, amtY: 0 },
    result: { success: true },
    walletBefore: 10,
    pause: async () => {},
    readWallet: async () => null,
    readTokenBalance: async () => 1,
  });
  assert.equal(accounted.basis, "est");
  assert.equal(accounted.countsTowardDaily, false);
  assert.equal(day.realizedSol, -0.2);
});

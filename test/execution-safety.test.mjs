import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedSwapFeeAllowance,
  isAmbiguousExecutionError,
  verifyJupiterSlippageBinding,
} from "../hands/tools/wallet.js";
import { evaluateSwapSafety, REJECT } from "../hands/tools/swap-guard.js";
import { config } from "../hands/config.js";

test("swap fees use the bounded RPC quote, not a fixed 20000 lamports", () => {
  assert.equal(boundedSwapFeeAllowance(113_507, { maxFeeLamports: 1_000_000 }), 113_507);
  assert.equal(boundedSwapFeeAllowance(40_000, { maxFeeLamports: 1_000_000 }), 40_000);
  assert.equal(boundedSwapFeeAllowance(1_000_000, { maxFeeLamports: 1_000_000 }), 1_000_000);
  assert.throws(
    () => boundedSwapFeeAllowance(1_000_001, { maxFeeLamports: 1_000_000 }),
    /exceeds ceiling/,
  );
  assert.throws(() => boundedSwapFeeAllowance(null), /no usable transaction fee quote/);
  assert.throws(() => boundedSwapFeeAllowance(0), /no usable transaction fee quote/);
  assert.throws(() => boundedSwapFeeAllowance(10.5), /no usable transaction fee quote/);
  assert.equal(
    boundedSwapFeeAllowance(null, { maxFeeLamports: 1_000_000, walletPaysFee: false }),
    0,
    "a gasless transaction must not credit another payer's fee to the taker",
  );
});

test("swap fee ceiling is explicit and permits legitimate fees above 20000 lamports", () => {
  assert.equal(Number.isSafeInteger(config.management.maxSwapFeeLamports), true);
  assert.ok(config.management.maxSwapFeeLamports > 20_000);
  assert.equal(
    boundedSwapFeeAllowance(20_001, {
      maxFeeLamports: config.management.maxSwapFeeLamports,
    }),
    20_001,
  );
});

test("fee headroom is not credited toward minimum swap output", () => {
  const quotedFee = boundedSwapFeeAllowance(113_507, { maxFeeLamports: 1_000_000 });
  assert.equal(quotedFee, 113_507, "only the RPC-quoted fee may be removed from the simulated SOL delta");

  const base = {
    direction: "token_to_sol",
    inputMint: "2pouN3by7twkiZGy5aEKYUpf78ALDpKRTNu2WsQkpkqt",
    outputMint: "So11111111111111111111111111111111111111112",
    inputAmountAtomic: "1000",
    quotedOutAtomic: "10000000",
    slippageBps: 300,
    priceImpactPct: 1,
  };
  const healthy = evaluateSwapSafety({
    ...base,
    simulate: {
      ok: true,
      walletFound: true,
      solDeltaLamports: String(10_000_000 - quotedFee),
      feeLamports: String(quotedFee),
      tokenDeltas: { [base.inputMint]: "-1000" },
    },
  });
  assert.equal(healthy.safe, true, healthy.reason);

  const belowMinimum = evaluateSwapSafety({
    ...base,
    simulate: {
      ok: true,
      walletFound: true,
      solDeltaLamports: String(9_699_999 - quotedFee),
      feeLamports: String(quotedFee),
      tokenDeltas: { [base.inputMint]: "-1000" },
    },
  });
  assert.equal(belowMinimum.safe, false);
  assert.equal(belowMinimum.code, REJECT.OUTPUT_BELOW_MINIMUM);
});

test("Jupiter order must prove the requested slippage is bound", () => {
  assert.deepEqual(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 300,
      swapMode: "ExactIn",
    }, 300),
    { bound: true, evidence: "slippageBps", appliedSlippageBps: 300 },
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 200,
      swapMode: "ExactIn",
    }, 300).bound,
    true,
    "a stricter applied slippage remains safe",
  );
  const threshold = verifyJupiterSlippageBinding({
    outAmount: "10000000",
    slippageBps: 500,
    swapMode: "ExactIn",
    otherAmountThreshold: "9700000",
  }, 300);
  assert.equal(threshold.bound, true);
  assert.equal(threshold.evidence, "otherAmountThreshold");
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      swapMode: "ExactIn",
      otherAmountThreshold: "9700000",
    }, 300).bound,
    true,
    "an ExactIn minimum-output threshold is equivalent protection when slippageBps is absent",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      swapMode: "ExactIn",
      otherAmountThreshold: "9699999",
    }, 300).bound,
    false,
    "minimum-output evidence must not be rounded below the requested bound",
  );

  assert.equal(verifyJupiterSlippageBinding({ outAmount: "10000000" }, 300).bound, false);
  assert.equal(
    verifyJupiterSlippageBinding({ outAmount: "10000000", slippageBps: 300 }, 300).bound,
    false,
    "an echoed slippage value without explicit ExactIn semantics is not binding evidence",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 300,
      swapMode: "ExactIn",
      otherAmountThreshold: "9000000",
    }, 300).bound,
    false,
    "a contradictory minimum-output threshold overrides an echoed slippage value",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 500,
      swapMode: "ExactIn",
      otherAmountThreshold: "9499999",
    }, 300).bound,
    false,
    "a looser provider response must fail closed",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 301,
      swapMode: "ExactIn",
    }, 300).bound,
    false,
    "an echoed slippage wider than requested must fail closed",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 300,
      swapMode: "ExactOut",
      otherAmountThreshold: "9700000",
    }, 300).bound,
    false,
    "an ExactOut threshold is not minimum-output evidence for this ExactIn request",
  );
  assert.equal(
    verifyJupiterSlippageBinding({
      outAmount: "10000000",
      slippageBps: 300.5,
      swapMode: "ExactIn",
    }, 300).bound,
    false,
    "malformed response slippage is not binding evidence",
  );
  assert.equal(verifyJupiterSlippageBinding({ outAmount: "10000000" }, 0).bound, false);
});

test("Jupiter minimum-output evidence uses exact atomic integer arithmetic", () => {
  const outAmount = "900719925474099312345";
  const expectedMin = (BigInt(outAmount) * 9700n / 10000n).toString();
  const result = verifyJupiterSlippageBinding({
    outAmount,
    slippageBps: 500,
    swapMode: "ExactIn",
    otherAmountThreshold: expectedMin,
  }, 300);
  assert.equal(result.bound, true);
  assert.equal(result.minimumOutAtomic, expectedMin);
});

test("ambiguous Jupiter execution errors are classified for reconciliation", () => {
  const expired = new Error("Transaction was not confirmed before block height exceeded");
  assert.equal(isAmbiguousExecutionError(expired), true);
});

test("ordinary execution failures are not classified as ambiguous", () => {
  const failure = new Error("custom program error: 0x1");
  assert.equal(isAmbiguousExecutionError(failure), false);
});

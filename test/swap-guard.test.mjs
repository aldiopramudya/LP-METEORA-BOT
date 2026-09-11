/**
 * F3 — execution-safety gate tests.
 *
 * Everything here is pure: no RPC, no network, no chain, no funds. The guard decides
 * from plain numbers, so the whole surface is deterministic.
 *
 * The regression anchor is audit cycle 30 (2026-09-10 21:09): a token→SOL liquidation
 * routed through the HumidiFi private AMM moved 16,263,144 lamports of NATIVE SOL out of
 * the wallet on top of the token input, realising ~10,296 lamports. It was 48% of the
 * audited wallet loss and nothing in the old code could see it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATOMIC_ROUNDING_TOLERANCE,
  DEFAULT_LIQUIDATION_SLIPPAGE_BPS,
  MAX_LIQUIDATION_SLIPPAGE_BPS,
  MIN_LIQUIDATION_SLIPPAGE_BPS,
  REJECT,
  computeMinOutAtomic,
  computeSimulationEffects,
  describeRejection,
  evaluateSwapSafety,
  parseSplTokenAccountAmount,
  priceImpactPercent,
  resolveSlippageBps,
  swapDirection,
} from "../hands/tools/swap-guard.js";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "2pouN3by7twkiZGy5aEKYUpf78ALDpKRTNu2WsQkpkqt";
const OTHER_TOKEN = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const WALLET = "AP5rGXwFcddV1iMtxnqRFZ51VjVxLmRjBvymDP9377ip";

/** Build a simulate block. `solDelta` is the wallet's raw post-pre balance change. */
function sim({ solDelta, fee = 5000, tokens = {}, ok = true, err = null, walletFound = true } = {}) {
  return {
    ok, err, walletFound,
    solDeltaLamports: solDelta === undefined ? null : String(solDelta),
    feeLamports: String(fee),
    tokenDeltas: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, String(v)])),
  };
}

/** A healthy token→SOL liquidation: 152.579116 tokens → 0.01 SOL quoted, 0.01 realised. */
function goodCtx(over = {}) {
  return {
    direction: "token_to_sol",
    inputMint: TOKEN,
    outputMint: SOL,
    wallet: WALLET,
    inputAmountAtomic: "152579116",
    quotedOutAtomic: "10000000",
    slippageBps: 300,
    priceImpactPct: 1,
    maxPriceImpactPct: 6,
    rejectOnMissingPriceImpact: true,
    simulate: sim({ solDelta: 10_000_000 - 5000, fee: 5000, tokens: { [TOKEN]: "-152579116" } }),
    ...over,
  };
}

// ───────────────────────────── happy path ─────────────────────────────

test("F3: a healthy token→SOL liquidation passes", () => {
  const d = evaluateSwapSafety(goodCtx());
  assert.equal(d.safe, true, d.reason);
  assert.equal(d.code, REJECT.OK);
  assert.equal(String(d.minOutAtomic), "9700000"); // 0.01 SOL - 3%
});

test("F3: a normal network fee does not falsely fail the route", () => {
  // solDelta is the output minus the fee; netSolCredit restores the output.
  const d = evaluateSwapSafety(goodCtx({ simulate: sim({ solDelta: 10_000_000 - 5000, fee: 5000, tokens: { [TOKEN]: "-152579116" } }) }));
  assert.equal(d.safe, true, d.reason);
  assert.equal(String(d.netSolCreditLamports), "10000000");
});

test("F3: a route that leaves the output as wSOL is not falsely rejected", () => {
  // native SOL only moves by the fee; the proceeds sit in the wallet's own wSOL ATA.
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: -5000, fee: 5000, tokens: { [TOKEN]: "-152579116", [SOL]: "10000000" } }),
  }));
  assert.equal(d.safe, true, d.reason);
  assert.equal(String(d.details.realisedOutLamports), "10000000");
});

// ─────────────────── the audited failure, reproduced ───────────────────

test("F3 REGRESSION (cycle 30): the HumidiFi route that debited 16,263,144 lamports of native SOL is rejected", () => {
  const d = evaluateSwapSafety(goodCtx({
    quotedOutAtomic: "10296",
    simulate: sim({ solDelta: -16_263_144, fee: 113507, tokens: { [TOKEN]: "-152579116" } }),
  }));
  assert.equal(d.safe, false);
  assert.ok(
    [REJECT.UNEXPECTED_SOL_DEBIT, REJECT.OUTPUT_BELOW_MINIMUM].includes(d.code),
    `expected a SOL-debit/output rejection, got ${d.code}: ${d.reason}`,
  );
});

test("F3: output satisfied but native SOL still leaving the wallet → UNEXPECTED_SOL_DEBIT", () => {
  // 0.0097 wSOL comes back (>= minOut) while 0.02 native SOL leaves the wallet.
  // netSolCredit = -20_000_000 + 5_000 = -19_995_000, so the reported debit is 19_995_000.
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: -20_000_000, fee: 5000, tokens: { [TOKEN]: "-152579116", [SOL]: "9700000" } }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.UNEXPECTED_SOL_DEBIT);
  assert.match(d.reason, /debits 19995000 lamports of native SOL/);
  assert.match(d.reason, /wSol offset 9700000/);
});

test("F3: a wSOL credit offsets a matching native debit, but a larger debit is still rejected", () => {
  // 0.0097 wSOL returns (>= minOut) while 0.012 native SOL leaves: the 0.0097 is
  // self-offsetting, the extra ~0.0023 is not, and must be rejected.
  const ctx = goodCtx({
    simulate: sim({ solDelta: -12_000_000, fee: 5000, tokens: { [TOKEN]: "-152579116", [SOL]: "10000000" } }),
  });
  const d = evaluateSwapSafety(ctx);
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.UNEXPECTED_SOL_DEBIT);

  // Declaring exactly that extra debit as an expected temporary amount lets it through.
  const d2 = evaluateSwapSafety({ ...ctx, allowances: { temporarySolDebitLamports: 2_000_000 } });
  assert.equal(d2.safe, true, d2.reason);
});

test("F3: a fully self-offsetting wrap (debit == wSOL credit) passes without an allowance", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: -1_000_000, fee: 5000, tokens: { [TOKEN]: "-152579116", [SOL]: "10000000" } }),
  }));
  assert.equal(d.safe, true, d.reason);
});

// ───────────────────────── boundary violations ─────────────────────────

test("F3: excessive slippage fails (realised far below the quote)", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: 5_000_000 - 5000, fee: 5000, tokens: { [TOKEN]: "-152579116" } }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.OUTPUT_BELOW_MINIMUM);
});

test("F3: a missing quote output fails (no minimum can be derived)", () => {
  const d = evaluateSwapSafety(goodCtx({ quotedOutAtomic: null }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.MISSING_QUOTE_OUTPUT);
});

test("F3: a non-positive quote output fails", () => {
  const d = evaluateSwapSafety(goodCtx({ quotedOutAtomic: "0" }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.QUOTE_OUTPUT_NOT_POSITIVE);
});

test("F3: a missing slippage bound fails instead of falling back to a provider default", () => {
  const d = evaluateSwapSafety(goodCtx({ slippageBps: 0 }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.SLIPPAGE_INVALID);
});

test("F3: an unrelated token debit fails", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({
      solDelta: 10_000_000 - 5000, fee: 5000,
      tokens: { [TOKEN]: "-152579116", [OTHER_TOKEN]: "-5000" },
    }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.UNRELATED_TOKEN_DEBIT);
});

test("F3: the input token not being debited fails", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: 10_000_000 - 5000, fee: 5000, tokens: {} }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.INPUT_TOKEN_NOT_DEBITED);
});

test("F3: debiting more of the input than was offered fails", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: 10_000_000 - 5000, fee: 5000, tokens: { [TOKEN]: "-999999999" } }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.INPUT_TOKEN_OVER_DEBITED);
});

test("F3: rounding tolerance does not reject an exact-fill input", () => {
  const d = evaluateSwapSafety(goodCtx({
    simulate: sim({ solDelta: 10_000_000 - 5000, fee: 5000, tokens: { [TOKEN]: `-${152579116n + ATOMIC_ROUNDING_TOLERANCE}` } }),
  }));
  assert.equal(d.safe, true, d.reason);
});

// ─────────────────────── fail-closed on missing data ───────────────────────

test("F3: no simulation → fail closed (never sign an unverified transaction)", () => {
  const d = evaluateSwapSafety(goodCtx({ simulate: null }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.SIMULATION_UNAVAILABLE);
});

test("F3: a failed simulation is a rejection", () => {
  const d = evaluateSwapSafety(goodCtx({ simulate: sim({ ok: false, err: "InstructionError" }) }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.SIMULATION_FAILED);
});

test("F3: a simulation without the wallet account is a rejection", () => {
  const d = evaluateSwapSafety(goodCtx({ simulate: sim({ solDelta: 10_000_000, walletFound: false }) }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.WALLET_NOT_IN_SIMULATION);
});

test("F3: a missing wallet SOL delta in the simulation is a rejection", () => {
  const d = evaluateSwapSafety(goodCtx({ simulate: sim({ solDelta: undefined }) }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.SIMULATION_UNAVAILABLE);
});

test("F3: an unknown direction is a rejection", () => {
  const d = evaluateSwapSafety(goodCtx({ direction: "sideways" }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.DIRECTIONS_UNSUPPORTED);
});

// ─────────────────────────── price impact ───────────────────────────

test("F3: a missing priceImpactPct is NOT treated as safe", () => {
  const d = evaluateSwapSafety(goodCtx({ priceImpactPct: null }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.PRICE_IMPACT_MISSING);
});

test("F3: opting out of the price-impact requirement still enforces the output bound", () => {
  // The relaxation must not become a bypass: a bad route is still rejected.
  const d = evaluateSwapSafety(goodCtx({
    priceImpactPct: null,
    rejectOnMissingPriceImpact: false,
    simulate: sim({ solDelta: 1 - 5000, fee: 5000, tokens: { [TOKEN]: "-152579116" } }),
  }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.OUTPUT_BELOW_MINIMUM);
  // ...and the missing value is surfaced, not hidden.
  const ok = evaluateSwapSafety(goodCtx({ priceImpactPct: null, rejectOnMissingPriceImpact: false }));
  assert.equal(ok.safe, true);
  assert.equal(ok.details.priceImpactMissing, true);
});

test("F3: quoted price impact above the ceiling is rejected", () => {
  const d = evaluateSwapSafety(goodCtx({ priceImpactPct: 9 }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.PRICE_IMPACT_TOO_HIGH);
});

test("F3: priceImpactPercent reproduces the repo's existing normalization (fraction → percent)", () => {
  // Jupiter returns a fraction; the split rule has always used *100. If this normalization
  // is skipped, a 6.16% route is compared as 0.0616% and the ceiling never fires.
  assert.equal(priceImpactPercent(0.0616), 6.16);
  assert.equal(priceImpactPercent("0.2"), 20);
  assert.equal(priceImpactPercent(-0.05), 5);
  assert.equal(priceImpactPercent(0), 0);
  assert.equal(priceImpactPercent(null), null);
  assert.equal(priceImpactPercent(undefined), null);
  assert.equal(priceImpactPercent("nonsense"), null);
});

test("F3 REGRESSION: a real 6.16% impact quote is NOT silently treated as negligible", () => {
  // Raw fraction straight into the guard would pass; the normalized percent must reject.
  const raw = 0.0616;
  const normalized = priceImpactPercent(raw);
  assert.equal(evaluateSwapSafety(goodCtx({ priceImpactPct: normalized })).safe, false);
  assert.equal(evaluateSwapSafety(goodCtx({ priceImpactPct: normalized })).code, REJECT.PRICE_IMPACT_TOO_HIGH);
  // And a comfortably low impact still passes, so the check has not simply become a block.
  assert.equal(evaluateSwapSafety(goodCtx({ priceImpactPct: priceImpactPercent(0.005) })).safe, true);
});

test("F3: a route that funds a new token account is rejected by default but admits an explicit rent allowance", () => {
  // wSol returns exactly minOut (output check satisfied) while native SOL leaves the
  // wallet in excess of it — 2,034,280 lamports more than the wSol credit covers, which
  // is what a route funding one new token account would look like. Default allowance 0
  // → rejected; with the rent declared explicitly → allowed.
  const ATA_RENT = 2_039_280;
  const ctx = goodCtx({
    minUsefulOutAtomic: "9000000",
    simulate: sim({
      solDelta: -(9_700_000 + ATA_RENT + 5000), fee: 5000,
      tokens: { [TOKEN]: "-152579116", [SOL]: "9700000" },
    }),
  });
  const d = evaluateSwapSafety(ctx);
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.UNEXPECTED_SOL_DEBIT);
  assert.match(d.reason, /liquidationSolDebitAllowanceLamports/); // actionable, not a dead end

  const d2 = evaluateSwapSafety({ ...ctx, allowances: { temporarySolDebitLamports: ATA_RENT } });
  assert.equal(d2.safe, true, d2.reason);
});

test("F3: the price-impact check is retained, not replaced, by the simulation gate", () => {
  // A route that simulates cleanly but quotes absurd impact is still rejected.
  const d = evaluateSwapSafety(goodCtx({ priceImpactPct: 50 }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.PRICE_IMPACT_TOO_HIGH);
});

// ─────────────────────────── dust floor ───────────────────────────

test("F3: refusing to pay gas for a dust-sized output", () => {
  const d = evaluateSwapSafety(goodCtx({ minUsefulOutAtomic: "20000000" }));
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.OUTPUT_BELOW_DUST_FLOOR);
});

// ─────────────────────── other directions ───────────────────────

test("F3: a healthy SOL→token swap passes", () => {
  const d = evaluateSwapSafety({
    direction: "sol_to_token",
    inputMint: SOL, outputMint: TOKEN, wallet: WALLET,
    inputAmountAtomic: "10000000",
    quotedOutAtomic: "152579116",
    slippageBps: 300, priceImpactPct: 1,
    simulate: sim({ solDelta: -10_000_000, fee: 5000, tokens: { [TOKEN]: "152579116" } }),
  });
  assert.equal(d.safe, true, d.reason);
});

test("F3: a SOL→token swap spending more than offered fails", () => {
  const d = evaluateSwapSafety({
    direction: "sol_to_token",
    inputMint: SOL, outputMint: TOKEN, wallet: WALLET,
    inputAmountAtomic: "10000000",
    quotedOutAtomic: "152579116",
    slippageBps: 300, priceImpactPct: 1,
    simulate: sim({ solDelta: -50_000_000, fee: 5000, tokens: { [TOKEN]: "152579116" } }),
  });
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.UNEXPECTED_SOL_DEBIT);
});

test("F3: a healthy token→token swap passes", () => {
  const d = evaluateSwapSafety({
    direction: "other",
    inputMint: TOKEN, outputMint: OTHER_TOKEN, wallet: WALLET,
    inputAmountAtomic: "1000",
    quotedOutAtomic: "5000",
    slippageBps: 300, priceImpactPct: 1,
    simulate: sim({ solDelta: -5000, fee: 5000, tokens: { [TOKEN]: "-1000", [OTHER_TOKEN]: "5000" } }),
  });
  assert.equal(d.safe, true, d.reason);
});

test("F3: a token→token swap delivering too little fails", () => {
  const d = evaluateSwapSafety({
    direction: "other",
    inputMint: TOKEN, outputMint: OTHER_TOKEN, wallet: WALLET,
    inputAmountAtomic: "1000",
    quotedOutAtomic: "5000",
    slippageBps: 300, priceImpactPct: 1,
    simulate: sim({ solDelta: -5000, fee: 5000, tokens: { [TOKEN]: "-1000", [OTHER_TOKEN]: "100" } }),
  });
  assert.equal(d.safe, false);
  assert.equal(d.code, REJECT.OUTPUT_BELOW_MINIMUM);
});

// ─────────────────── slippage is bounded, never loosened ───────────────────

test("F3: an invalid or absent slippage value falls back to the conservative default", () => {
  assert.equal(resolveSlippageBps(undefined), DEFAULT_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(resolveSlippageBps(null), DEFAULT_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(resolveSlippageBps("nonsense"), DEFAULT_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(resolveSlippageBps(-5), DEFAULT_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(DEFAULT_LIQUIDATION_SLIPPAGE_BPS, 300);
});

test("F3: slippage is clamped into the safe band and can never be widened past the ceiling", () => {
  assert.equal(resolveSlippageBps(1), MIN_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(resolveSlippageBps(999999), MAX_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(resolveSlippageBps(500), 500);
  assert.equal(MAX_LIQUIDATION_SLIPPAGE_BPS, 2000);
});

test("F3: the guard is deterministic — a rejected route re-quoted with the same numbers is rejected again", () => {
  // Re-quoting may return a different route; it must never return a looser verdict for
  // the same economics. The guard holds no state and no memory of prior rejections.
  const ctx = goodCtx({ simulate: sim({ solDelta: 1 - 5000, fee: 5000, tokens: { [TOKEN]: "-152579116" } }) });
  const a = evaluateSwapSafety(ctx);
  const b = evaluateSwapSafety(ctx);
  assert.equal(a.safe, false);
  assert.deepEqual({ safe: a.safe, code: a.code }, { safe: b.safe, code: b.code });
});

test("F3: computeMinOutAtomic applies the bound and rejects unusable quotes", () => {
  assert.equal(String(computeMinOutAtomic("10000000", 300)), "9700000");
  // An over-wide slippage request is CLAMPED, never honoured: 10000 bps would zero the
  // minimum out of existence, so it is capped at the 2000 bps ceiling instead.
  assert.equal(String(computeMinOutAtomic("10000000", 10000)), "8000000");
  assert.equal(resolveSlippageBps(10000), MAX_LIQUIDATION_SLIPPAGE_BPS);
  assert.equal(computeMinOutAtomic("0", 300), null);
  assert.equal(computeMinOutAtomic(null, 300), null);
});

// ───────────────────────── direction helper ─────────────────────────

test("F3: swapDirection classifies the mint pair", () => {
  assert.equal(swapDirection(TOKEN, SOL), "token_to_sol");
  assert.equal(swapDirection(SOL, TOKEN), "sol_to_token");
  assert.equal(swapDirection(TOKEN, OTHER_TOKEN), "other");
});

// ──────────────── simulation reduction (ALT-safe alignment) ────────────────

/** Build a Solana token-account buffer whose `amount` (offset 64, u64 LE) is `amount`. */
function tokenAccountBuffer(amount) {
  const buf = Buffer.alloc(165);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  return buf;
}

test("F3: parseSplTokenAccountAmount reads the u64 amount at offset 64", () => {
  assert.equal(String(parseSplTokenAccountAmount(tokenAccountBuffer(123456n))), "123456");
  assert.equal(String(parseSplTokenAccountAmount(tokenAccountBuffer(0n))), "0");
  assert.equal(parseSplTokenAccountAmount(Buffer.alloc(10)), null);
  assert.equal(parseSplTokenAccountAmount(null), null);
});

test("F3: computeSimulationEffects aligns by the requested address order, not transaction index", () => {
  // Address-lookup-table accounts are absent from staticAccountKeys, so index-based
  // alignment would silently compare the wrong account. Ownership of the order fixes it.
  const owner = WALLET;
  const ataA = "AtaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const addressOrder = [owner, ataA];
  const effects = computeSimulationEffects({
    owner,
    preSolLamports: 2_766_005_320,
    preTokenAccounts: { [ataA]: { mint: TOKEN, amountAtomic: "152579116" } },
    postAccounts: [
      { lamports: 2_766_005_320 + 10_000_000 - 5000, data: null },   // owner
      { lamports: 2_039_280, data: [tokenAccountBuffer(0).toString("base64"), "base64"] }, // ataA
    ],
    addressOrder,
    feeAllowanceLamports: 5000,
  });
  assert.equal(effects.ok, true, effects.err);
  assert.equal(effects.walletFound, true);
  assert.equal(effects.solDeltaLamports, String(10_000_000 - 5000));
  assert.equal(effects.tokenDeltas[TOKEN], String(-152579116));
});

test("F3: computeSimulationEffects refuses a misaligned post-state instead of guessing", () => {
  const effects = computeSimulationEffects({
    owner: WALLET,
    preSolLamports: 100,
    preTokenAccounts: {},
    postAccounts: [{ lamports: 1 }],
    addressOrder: [WALLET, "another-account"],
    feeAllowanceLamports: 0,
  });
  assert.equal(effects.ok, false);
  assert.match(String(effects.err), /does not align/);
});

test("F3: computeSimulationEffects never reports a fabricated zero on missing data", () => {
  const effects = computeSimulationEffects({
    owner: WALLET,
    preSolLamports: null,
    preTokenAccounts: {},
    postAccounts: [{ lamports: 5 }],
    addressOrder: [WALLET],
  });
  assert.equal(effects.ok, false);
  assert.equal(effects.solDeltaLamports, null);
});

// ─────────────────────────── rejection logging ───────────────────────────

test("F3: a rejection record carries the diagnosis and no secret material", () => {
  const ctx = goodCtx({ simulate: sim({ solDelta: -20_000_000, fee: 5000, tokens: { [TOKEN]: "-152579116", [SOL]: "9700000" } }) });
  const d = evaluateSwapSafety(ctx);
  const rec = describeRejection({
    route: "HumidiFi",
    provider: "jupiter",
    decision: d,
    inputMint: TOKEN,
    outputMint: SOL,
    inputAmountAtomic: ctx.inputAmountAtomic,
    quotedOutAtomic: ctx.quotedOutAtomic,
    slippageBps: ctx.slippageBps,
    simulatedSolDeltaLamports: ctx.simulate.solDeltaLamports,
    priceImpactPct: ctx.priceImpactPct,
  });
  assert.equal(rec.event, "swap_rejected");
  assert.equal(rec.reason, REJECT.UNEXPECTED_SOL_DEBIT);
  assert.equal(rec.provider, "jupiter");
  assert.equal(rec.route, "HumidiFi");
  assert.equal(rec.min_out_atomic, "9700000");
  assert.equal(rec.simulated_sol_delta_lamports, "-20000000");
  const serialized = JSON.stringify(rec).toLowerCase();
  for (const forbidden of ["private", "secret", "seed", "mnemonic", "keypair", "privatekey"]) {
    assert.equal(serialized.includes(forbidden), false, `rejection log must not contain "${forbidden}"`);
  }
});

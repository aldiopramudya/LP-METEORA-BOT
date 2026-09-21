/**
 * swap-guard — PURE decision layer for liquidation safety (F3).
 *
 * No I/O, no imports, no chain access. Every input is a plain number/string so the
 * whole decision surface is unit-testable without web3, an RPC, or a network.
 *
 * WHY THIS EXISTS (forensic audit, cycle 30 / 2026-09-10 21:09):
 *   A token->SOL liquidation routed through the HumidiFi private AMM moved
 *   16,263,144 lamports of NATIVE SOL out of the wallet on top of the token input:
 *   the wallet was debited 0.013722660 SOL to realise ~0.000010296 SOL of output.
 *   31 of 32 cycles were flat. That single route was ~48% of the audited loss.
 *   The old code trusted the quote: it deserialised `order.transaction`, signed it,
 *   and posted it to /execute, with no slippage bound and no simulation. Nothing
 *   inspected what the transaction would actually do to the wallet.
 *
 * The guard is intentionally composed of independent checks that each fail closed.
 * A route is signed only if EVERY check passes. Missing data is a rejection, never
 * an implicit pass.
 */

/** Jupiter/Helius native SOL mint (wrapped SOL == the SOL side of any route). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Conservative default liquidation slippage. 300 bps = 3%.
 *
 * This is an EXECUTION-SAFETY bound, not a strategy parameter: it does not change
 * when we trade, what we trade, or how much. It only widens/narrows the band inside
 * which a liquidation route is considered sane. 3% is deliberately loose enough that
 * an ordinary memecoin exit is never blocked by normal spread, and tight enough that
 * the audited failure (a 99.9% shortfall) is impossible to sign.
 */
export const DEFAULT_LIQUIDATION_SLIPPAGE_BPS = 300;
export const MIN_LIQUIDATION_SLIPPAGE_BPS = 10;    // 0.1%
export const MAX_LIQUIDATION_SLIPPAGE_BPS = 2000;  // 20% — hard ceiling, never exceeded

/** Tolerance for integer rounding when comparing atomic amounts. */
export const ATOMIC_ROUNDING_TOLERANCE = 2n;

export const REJECT = {
  OK: "OK",
  DIRECTIONS_UNSUPPORTED: "DIRECTIONS_UNSUPPORTED",
  MISSING_QUOTE_OUTPUT: "MISSING_QUOTE_OUTPUT",
  QUOTE_OUTPUT_NOT_POSITIVE: "QUOTE_OUTPUT_NOT_POSITIVE",
  SLIPPAGE_INVALID: "SLIPPAGE_INVALID",
  PRICE_IMPACT_MISSING: "PRICE_IMPACT_MISSING",
  PRICE_IMPACT_TOO_HIGH: "PRICE_IMPACT_TOO_HIGH",
  SIMULATION_UNAVAILABLE: "SIMULATION_UNAVAILABLE",
  SIMULATION_FAILED: "SIMULATION_FAILED",
  WALLET_NOT_IN_SIMULATION: "WALLET_NOT_IN_SIMULATION",
  INPUT_TOKEN_NOT_DEBITED: "INPUT_TOKEN_NOT_DEBITED",
  INPUT_TOKEN_OVER_DEBITED: "INPUT_TOKEN_OVER_DEBITED",
  UNEXPECTED_SOL_DEBIT: "UNEXPECTED_SOL_DEBIT",
  UNRELATED_TOKEN_DEBIT: "UNRELATED_TOKEN_DEBIT",
  OUTPUT_BELOW_MINIMUM: "OUTPUT_BELOW_MINIMUM",
  OUTPUT_BELOW_DUST_FLOOR: "OUTPUT_BELOW_DUST_FLOOR",
};

const toBig = (v) => {
  if (typeof v === "bigint") return v;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.trunc(n));
};

/**
 * Clamp a configured slippage value into the safe band. Never throws, never widens
 * past the hard ceiling, and falls back to the conservative default on garbage input.
 */
export function resolveSlippageBps(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIQUIDATION_SLIPPAGE_BPS;
  const i = Math.round(n);
  if (i < MIN_LIQUIDATION_SLIPPAGE_BPS) return MIN_LIQUIDATION_SLIPPAGE_BPS;
  if (i > MAX_LIQUIDATION_SLIPPAGE_BPS) return MAX_LIQUIDATION_SLIPPAGE_BPS;
  return i;
}

/** Minimum acceptable output for a quoted output, in atomic units. */
export function computeMinOutAtomic(quotedOutAtomic, slippageBps) {
  const quoted = toBig(quotedOutAtomic);
  if (quoted === null || quoted <= 0n) return null;
  const bps = BigInt(resolveSlippageBps(slippageBps));
  const floor = (quoted * (10000n - bps)) / 10000n;
  return floor > 0n ? floor : 1n;
}

/**
 * Decide whether a token->SOL (or SOL->token / token->token) swap may be signed.
 *
 * @param {object} ctx
 * @param {"token_to_sol"|"sol_to_token"|"other"} ctx.direction
 * @param {string} ctx.inputMint                 mint being sold
 * @param {string} ctx.outputMint                mint being bought
 * @param {string} [ctx.wallet]                  fee-payer / owner pubkey
 * @param {string|number|bigint} ctx.inputAmountAtomic  amount requested, atomic units
 * @param {string|number|bigint} ctx.quotedOutAtomic    order.outAmount, atomic units
 * @param {number} ctx.slippageBps
 * @param {number|null|undefined} ctx.priceImpactPct    order.priceImpactPct (percent, 0-100 scale as returned)
 * @param {number} [ctx.maxPriceImpactPct]
 * @param {boolean} [ctx.rejectOnMissingPriceImpact=true]
 * @param {object|null} ctx.simulate             simulation result; null => unavailable
 * @param {boolean} ctx.simulate.ok
 * @param {string} [ctx.simulate.err]
 * @param {string|number|bigint} [ctx.simulate.solDeltaLamports]   post-pre for wallet INCLUDING fee allowance
 * @param {string|number|bigint} [ctx.simulate.feeLamports]        EXPLICIT ALLOWANCE for the normal network fee
 *        (base + priority) the transaction is permitted to charge. It is an allowance, not a
 *        measured value: RPC simulation does not report the fee, and guessing a "measured"
 *        one would be worse than stating a bound. Documented, configurable, small.
 * @param {Record<string,string|number|bigint>} [ctx.simulate.tokenDeltas] mint -> atomic delta
 * @param {boolean} [ctx.simulate.walletFound=true]
 * @param {object} [ctx.allowances]
 * @param {string|number|bigint} [ctx.allowances.expectedSolDebitLamports=0]   deliberately spent (e.g. SOL->token input)
 * @param {string|number|bigint} [ctx.allowances.temporarySolDebitLamports=0]  rent that returns (wSOL wrap)
 * @param {string|number|bigint} [ctx.allowances.maxUnrelatedTokenDebitAtomic=0]
 * @param {number}  [ctx.allowances.solCreditToleranceLamports=0]
 * @param {string|number|bigint} [ctx.minUsefulOutAtomic=0]  reject outputs below this (dust floor)
 * @returns {{safe:boolean, code:string, reason:string, minOutAtomic:bigint|null, netSolCreditLamports:bigint|null, details:object}}
 */
export function evaluateSwapSafety(ctx = {}) {
  const d = {
    direction: ctx.direction,
    inputMint: ctx.inputMint ?? null,
    outputMint: ctx.outputMint ?? null,
    slippageBps: resolveSlippageBps(ctx.slippageBps),
    quotedOutAtomic: toBig(ctx.quotedOutAtomic),
    priceImpactPct: ctx.priceImpactPct === null || ctx.priceImpactPct === undefined ? null : Number(ctx.priceImpactPct),
    priceImpactMissing: ctx.priceImpactPct === null || ctx.priceImpactPct === undefined,
    simulationUsed: !!ctx.simulate,
  };
  const fail = (code, reason) => ({ safe: false, code, reason, minOutAtomic: out.minOutAtomic, netSolCreditLamports: out.netSolCreditLamports, details: { ...d, ...out } });

  const out = { minOutAtomic: null, netSolCreditLamports: null };

  // ── 0. direction must be known ───────────────────────────────────────────
  if (!["token_to_sol", "sol_to_token", "other"].includes(ctx.direction)) {
    return fail(REJECT.DIRECTIONS_UNSUPPORTED, `unknown swap direction ${String(ctx.direction)}`);
  }

  // ── 1. explicit slippage (never trust a provider default) ────────────────
  const rawSlip = Number(ctx.slippageBps);
  if (!Number.isFinite(rawSlip) || rawSlip <= 0) {
    return fail(REJECT.SLIPPAGE_INVALID, `slippage bps missing/invalid (${String(ctx.slippageBps)})`);
  }

  // ── 2. minimum output must be derivable ─────────────────────────────────
  if (d.quotedOutAtomic === null) {
    return fail(REJECT.MISSING_QUOTE_OUTPUT, "quote carries no usable outAmount — cannot derive a minimum output");
  }
  if (d.quotedOutAtomic <= 0n) {
    return fail(REJECT.QUOTE_OUTPUT_NOT_POSITIVE, `quoted output ${d.quotedOutAtomic} is not positive`);
  }
  const minOut = computeMinOutAtomic(d.quotedOutAtomic, d.slippageBps);
  out.minOutAtomic = minOut;

  // ── 3. price impact: missing is NOT safe ────────────────────────────────
  const maxImpact = Number(ctx.maxPriceImpactPct ?? 6);
  if (d.priceImpactMissing) {
    if (ctx.rejectOnMissingPriceImpact !== false) {
      return fail(REJECT.PRICE_IMPACT_MISSING,
        "route returned no priceImpactPct — refusing to treat missing impact as safe");
    }
  } else if (Number.isFinite(d.priceImpactPct) && d.priceImpactPct > maxImpact) {
    return fail(REJECT.PRICE_IMPACT_TOO_HIGH,
      `quoted price impact ${d.priceImpactPct}% exceeds ${maxImpact}%`);
  }

  // ── 4. simulation is mandatory; absent simulation fails closed ──────────
  const sim = ctx.simulate;
  if (!sim) {
    return fail(REJECT.SIMULATION_UNAVAILABLE, "no simulation result — refusing to sign unverified transaction");
  }
  if (sim.ok === false) {
    return fail(REJECT.SIMULATION_FAILED, `simulation failed: ${String(sim.err || "unknown").slice(0, 160)}`);
  }
  if (sim.walletFound === false) {
    return fail(REJECT.WALLET_NOT_IN_SIMULATION, "wallet account absent from simulation result");
  }

  const solDelta = toBig(sim.solDeltaLamports);
  const fee = toBig(sim.feeLamports) ?? 0n;
  const tokenDeltas = {};
  for (const [m, v] of Object.entries(sim.tokenDeltas || {})) {
    const b = toBig(v);
    if (b !== null) tokenDeltas[m] = b;
  }

  const allowExpected = toBig(ctx?.allowances?.expectedSolDebitLamports) ?? 0n;
  const allowTemp = toBig(ctx?.allowances?.temporarySolDebitLamports) ?? 0n;
  const allowUnrelated = toBig(ctx?.allowances?.maxUnrelatedTokenDebitAtomic) ?? 0n;
  const creditTolerance = BigInt(Math.max(0, Math.trunc(Number(ctx?.allowances?.solCreditToleranceLamports ?? 0))));
  const inputAmount = toBig(ctx.inputAmountAtomic);

  // net SOL credited to the wallet, network fee removed
  const netSolCredit = solDelta === null ? null : solDelta + fee;
  out.netSolCreditLamports = netSolCredit;

  if (solDelta === null) {
    return fail(REJECT.SIMULATION_UNAVAILABLE, "simulation result carried no wallet SOL delta");
  }

  const inputDelta = ctx.inputMint && ctx.inputMint in tokenDeltas ? tokenDeltas[ctx.inputMint] : null;
  const outputDelta = ctx.outputMint && ctx.outputMint in tokenDeltas ? tokenDeltas[ctx.outputMint] : null;

  // ── 5. unrelated token debits are never acceptable ─────────────────────
  for (const [mint, delta] of Object.entries(tokenDeltas)) {
    if (mint === ctx.inputMint || mint === ctx.outputMint) continue;
    if (delta < 0n && -delta > allowUnrelated) {
      return fail(REJECT.UNRELATED_TOKEN_DEBIT,
        `route debits unrelated token ${mint.slice(0, 8)} by ${-delta} atomic units`);
    }
  }

  if (ctx.direction === "token_to_sol") {
    // The input token must actually be spent...
    if (inputDelta === null || inputDelta >= 0n) {
      return fail(REJECT.INPUT_TOKEN_NOT_DEBITED, "input token was not debited by the simulated route");
    }
    // ...and never more than we asked for (rounding tolerance only).
    if (inputAmount !== null && -inputDelta > inputAmount + ATOMIC_ROUNDING_TOLERANCE) {
      return fail(REJECT.INPUT_TOKEN_OVER_DEBITED,
        `route debits ${-inputDelta} of input but only ${inputAmount} was offered`);
    }

    // SOL can arrive two ways: native (normal) or still wrapped in the wallet's own
    // wSOL account. Count both, so a route that leaves wSOL behind is not wrongly
    // rejected — and, more importantly, so native SOL that went to a THIRD PARTY has
    // nothing to offset it and is caught by the debit guard below.
    const wsolDelta = tokenDeltas[SOL_MINT] ?? 0n;
    const wsolCredit = wsolDelta > 0n ? wsolDelta : 0n;
    const nativeCredit = netSolCredit > 0n ? netSolCredit : 0n;
    const nativeDebit = netSolCredit < 0n ? -netSolCredit : 0n;
    const realisedOut = nativeCredit + wsolCredit;
    out.realisedOutLamports = realisedOut;

    if (realisedOut < minOut - creditTolerance) {
      return fail(REJECT.OUTPUT_BELOW_MINIMUM,
        `realised SOL output ${realisedOut} (native ${netSolCredit} + wSol ${wsolCredit}) below minimum ${minOut}`);
    }
    // A token sale must never be a net native-SOL debit beyond explicit allowances.
    // Wrapping into the wallet's own wSOL account is a temporary, self-offsetting debit;
    // SOL leaving to a third party is not, and is rejected here.
    const allowedDebit = allowExpected + allowTemp + fee + wsolCredit;
    if (nativeDebit > allowedDebit) {
      return fail(REJECT.UNEXPECTED_SOL_DEBIT,
        `route debits ${nativeDebit} lamports of native SOL; allowed ${allowedDebit} ` +
        `(expected ${allowExpected} + temporary ${allowTemp} + fee ${fee} + wSol offset ${wsolCredit}). ` +
        `If this route merely funds a NEW token account, raise liquidationSolDebitAllowanceLamports ` +
        `by the account rent (2039280) deliberately — do not lower the other bounds.`);
    }
  } else if (ctx.direction === "sol_to_token") {
    // SOL is deliberately spent here; only bound it.
    if (inputAmount !== null) {
      const solDebit = netSolCredit < 0n ? -netSolCredit : 0n;
      if (solDebit > inputAmount + allowTemp + creditTolerance) {
        return fail(REJECT.UNEXPECTED_SOL_DEBIT,
          `route spends ${solDebit} lamports but only ${inputAmount} was offered`);
      }
    }
    if (outputDelta === null || outputDelta < minOut - creditTolerance) {
      return fail(REJECT.OUTPUT_BELOW_MINIMUM,
        `realised output ${outputDelta ?? 0n} below minimum ${minOut}`);
    }
  } else {
    // Generic token->token: input debited, output credited at or above minimum.
    if (inputDelta === null || inputDelta >= 0n) {
      return fail(REJECT.INPUT_TOKEN_NOT_DEBITED, "input token was not debited by the simulated route");
    }
    if (outputDelta === null || outputDelta < minOut - creditTolerance) {
      return fail(REJECT.OUTPUT_BELOW_MINIMUM,
        `realised output ${outputDelta ?? 0n} below minimum ${minOut}`);
    }
  }

  // ── 6. dust-output guard: refuse to pay gas to realise nothing ──────────
  const dustFloor = toBig(ctx.minUsefulOutAtomic) ?? 0n;
  if (dustFloor > 0n) {
    const realised = ctx.direction === "token_to_sol"
      ? (out.realisedOutLamports ?? netSolCredit)
      : outputDelta;
    if (realised !== null && realised < dustFloor) {
      return fail(REJECT.OUTPUT_BELOW_DUST_FLOOR,
        `realised output ${realised} below dust floor ${dustFloor} — uneconomic to execute`);
    }
  }

  return { safe: true, code: REJECT.OK, reason: "all guards passed", minOutAtomic: out.minOutAtomic, netSolCreditLamports: out.netSolCreditLamports, details: { ...d, ...out } };
}

/**
 * Normalize a provider's price-impact field to PERCENT (0-100).
 *
 * Jupiter's Swap V2 `/order` returns `priceImpactPct` as a FRACTION (0.0616 == 6.16%).
 * This mirrors the normalization this repo already used for the swap-splitting rule, so
 * the guard and the split decision can never disagree about the same quote. Passing the
 * raw fraction straight into a percent comparison would understate impact by 100x and
 * silently switch the check off.
 *
 * @param {number|string|null|undefined} raw
 * @returns {number|null} percent, or null when absent/unusable
 */
export function priceImpactPercent(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.abs(Number(raw));
  return Number.isFinite(n) ? n * 100 : null;
}

/**
 * Structured rejection record for logging. Never includes keys or secrets — only
 * provider/mints/amounts that the operator needs to diagnose a blocked route.
 */
export function describeRejection({ route, provider, decision, inputMint, outputMint, inputAmountAtomic, quotedOutAtomic, slippageBps, expectedSolDebitLamports, simulatedSolDeltaLamports, priceImpactPct } = {}) {
  const r = decision || {};
  return {
    event: "swap_rejected",
    reason: r.code || "UNKNOWN",
    detail: r.reason || null,
    route: route ?? null,
    provider: provider ?? null,
    input_mint: inputMint ?? null,
    output_mint: outputMint ?? null,
    input_amount_atomic: inputAmountAtomic != null ? String(inputAmountAtomic) : null,
    quoted_out_atomic: quotedOutAtomic != null ? String(quotedOutAtomic) : null,
    min_out_atomic: r.minOutAtomic != null ? String(r.minOutAtomic) : null,
    slippage_bps: slippageBps ?? null,
    expected_sol_debit_lamports: expectedSolDebitLamports != null ? String(expectedSolDebitLamports) : null,
    simulated_sol_delta_lamports: simulatedSolDeltaLamports != null ? String(simulatedSolDeltaLamports) : null,
    net_sol_credit_lamports: r.netSolCreditLamports != null ? String(r.netSolCreditLamports) : null,
    price_impact_pct: priceImpactPct ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation-effect helpers (pure).
//
// Index alignment matters more than it looks: for a versioned transaction the RPC's
// preBalances/postBalances arrays are aligned with the FULL resolved account list,
// including accounts pulled in through an address lookup table — which
// `message.staticAccountKeys` does NOT contain. Indexing by transaction position would
// therefore silently compare the wrong account. Instead we hand the RPC an explicit
// address list via the `accounts` config and read the post-state back in OUR order.
// ─────────────────────────────────────────────────────────────────────────────

/** SPL Token / Token-2022 token account: `amount` is a u64 LE at byte offset 64. */
export function parseSplTokenAccountAmount(data) {
  let buf = data;
  if (typeof buf === "string") {
    try { buf = Buffer.from(buf, "base64"); } catch { return null; }
  }
  if (!buf || typeof buf.length !== "number" || buf.length < 72) return null;
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(buf[64 + k] & 0xff);
  return v;
}

/**
 * Reduce a pre-state snapshot plus a simulated post-state into the guard's `simulate`
 * input.
 *
 * @param {object} p
 * @param {string} p.owner                        wallet address
 * @param {string|number|bigint} p.preSolLamports wallet SOL balance before simulation
 * @param {Record<string,{mint:string,amountAtomic:string|number|bigint}>} p.preTokenAccounts
 *        address -> { mint, amountAtomic } for every token account we track
 * @param {Array<{lamports:number,data:(Buffer|Uint8Array|string|Array)}>|null} p.postAccounts
 *        simulated post-state, aligned with `addressOrder`
 * @param {string[]} p.addressOrder               [owner, ...tokenAccountAddresses]
 * @param {string|number|bigint} [p.feeAllowanceLamports=0]
 * @param {object|null} [p.simErr]
 * @returns {{ok:boolean, err:?string, walletFound:boolean, solDeltaLamports:string|null, feeLamports:string, tokenDeltas:Record<string,string>}}
 */
export function computeSimulationEffects({
  owner,
  preSolLamports,
  preTokenAccounts = {},
  postAccounts = null,
  addressOrder = [],
  feeAllowanceLamports = 0,
  simErr = null,
} = {}) {
  const base = {
    ok: false,
    err: simErr ? String(simErr).slice(0, 200) : null,
    walletFound: false,
    solDeltaLamports: null,
    feeLamports: String(toBig(feeAllowanceLamports) ?? 0n),
    tokenDeltas: {},
  };
  if (simErr) return base;
  if (!Array.isArray(postAccounts) || postAccounts.length !== addressOrder.length) {
    return { ...base, err: "simulation post-state does not align with the requested accounts" };
  }

  const ownerIdx = addressOrder.indexOf(owner);
  if (ownerIdx < 0) return { ...base, err: "owner missing from the simulated account list" };
  const ownerPost = postAccounts[ownerIdx];
  if (!ownerPost || typeof ownerPost.lamports !== "number") {
    return { ...base, err: "simulated owner account carried no lamports" };
  }

  const preSol = toBig(preSolLamports);
  if (preSol === null) return { ...base, err: "pre-simulation owner balance unavailable" };
  const solDelta = BigInt(ownerPost.lamports) - preSol;

  const tokenDeltas = {};
  for (let i = 0; i < addressOrder.length; i++) {
    const addr = addressOrder[i];
    if (addr === owner) continue;
    const pre = preTokenAccounts[addr];
    if (!pre) continue;
    const post = postAccounts[i];
    if (!post || post.data === undefined || post.data === null) continue;
    const raw = Array.isArray(post.data) ? post.data[0] : post.data;
    const postAmount = parseSplTokenAccountAmount(raw);
    if (postAmount === null) continue;
    const preAmount = toBig(pre.amountAtomic) ?? 0n;
    tokenDeltas[pre.mint] = (tokenDeltas[pre.mint] ?? 0n) + (postAmount - preAmount);
  }
  for (const [mint, v] of Object.entries(tokenDeltas)) tokenDeltas[mint] = v.toString();

  return {
    ok: true,
    err: null,
    walletFound: true,
    solDeltaLamports: solDelta.toString(),
    feeLamports: base.feeLamports,
    tokenDeltas,
  };
}

/** Direction of a swap, from the mint pair. */
export function swapDirection(inputMint, outputMint) {
  const i = inputMint === SOL_MINT;
  const o = outputMint === SOL_MINT;
  if (!i && o) return "token_to_sol";
  if (i && !o) return "sol_to_token";
  return "other";
}

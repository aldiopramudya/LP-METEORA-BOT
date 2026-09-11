import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import {
  computeSimulationEffects,
  describeRejection,
  evaluateSwapSafety,
  priceImpactPercent,
  resolveSlippageBps,
  swapDirection,
} from "./swap-guard.js";
import { STATUS } from "./liquidation-status.js";

// Exported at bottom for limit-exit.js (patient exit orders need signing + API key).
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = ""; // set JUPITER_API_KEY in .env (free key: portal.jup.ag)

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  // HARD BLOCK (user decision 2026-07-05): no referral fees to third parties, ever.
  return null;
  // eslint-disable-next-line no-unreachable
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Token programs enumerated when snapshotting wallet token state for the simulation gate. */
const TOKEN_PROGRAMS_FOR_SNAPSHOT = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

/**
 * Snapshot every token account the wallet owns, plus its native SOL balance.
 * Used as the "before" side of the pre/post simulation comparison.
 */
async function snapshotWalletTokenState(connection, owner) {
  const ownerKey = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const preTokenAccounts = {};
  const addresses = [];
  for (const programId of TOKEN_PROGRAMS_FOR_SNAPSHOT) {
    let res;
    try {
      res = await connection.getParsedTokenAccountsByOwner(ownerKey, { programId: new PublicKey(programId) });
    } catch (e) {
      log("swap_warn", `token snapshot failed for ${programId.slice(0, 8)}: ${e.message}`);
      continue;
    }
    for (const { pubkey, account } of res.value || []) {
      const info = account?.data?.parsed?.info;
      if (!info?.mint) continue;
      const addr = pubkey.toString();
      preTokenAccounts[addr] = { mint: String(info.mint), amountAtomic: String(info.tokenAmount?.amount ?? "0") };
      addresses.push(addr);
    }
  }
  const preSolLamports = await connection.getBalance(ownerKey);
  return { preSolLamports, preTokenAccounts, tokenAddresses: addresses };
}

/**
 * Simulate a deserialized swap transaction and reduce it to the guard's `simulate`
 * input. Returns null when the RPC cannot simulate (the caller then fails closed).
 *
 * Nothing is signed or submitted here: `sigVerify:false` lets the RPC simulate an
 * unsigned transaction, and `replaceRecentBlockhash:true` stops a stale blockhash from
 * producing a false failure.
 */
async function simulateSwapEffects(connection, owner, transaction, snapshot, feeAllowanceLamports) {
  const ownerStr = owner instanceof PublicKey ? owner.toString() : String(owner);
  const addressOrder = [ownerStr, ...snapshot.tokenAddresses];
  let res;
  try {
    res = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: addressOrder },
    });
  } catch (e) {
    log("swap_warn", `simulation unavailable: ${e.message}`);
    return { simulate: null, simErr: e.message };
  }
  if (!res?.value) return { simulate: null, simErr: "simulation returned no value" };
  if (res.value.err) {
    log("swap_warn", `simulation failed: ${JSON.stringify(res.value.err).slice(0, 160)}`);
    return { simulate: null, simErr: `simulation error: ${JSON.stringify(res.value.err).slice(0, 160)}` };
  }
  const sim = computeSimulationEffects({
    owner: ownerStr,
    preSolLamports: snapshot.preSolLamports,
    preTokenAccounts: snapshot.preTokenAccounts,
    postAccounts: res.value.accounts || null,
    addressOrder,
    feeAllowanceLamports,
  });
  return { simulate: sim, simErr: sim.ok ? null : sim.err };
}

/**
 * Authoritative, freshly-read on-chain token balance for one mint, in atomic units.
 * Returns null when the chain could not be read — callers must treat null as "unknown",
 * never as zero (a stale/absent read must not authorise closing an account).
 */
export async function getOnChainTokenBalanceAtomic(owner, mint) {
  const connection = getConnection();
  const ownerKey = owner instanceof PublicKey ? owner : new PublicKey(owner);
  try {
    for (const programId of TOKEN_PROGRAMS_FOR_SNAPSHOT) {
      const res = await connection.getParsedTokenAccountsByOwner(ownerKey, { programId: new PublicKey(programId) });
      for (const { account } of res.value || []) {
        const info = account?.data?.parsed?.info;
        if (info?.mint === mint) return BigInt(info.tokenAmount?.amount ?? "0");
      }
    }
    return 0n;
  } catch (e) {
    log("wallet_warn", `on-chain token balance read failed for ${String(mint).slice(0, 8)}: ${e.message}`);
    return null;
  }
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  _splitDepth = 0,
  _requoteAttempt = 0,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Execution-safety configuration (F3) ───────────────────
    // These are execution bounds, not strategy parameters: they do not change what we
    // trade, when we trade, or how much. See ./swap-guard.js for the rationale.
    const direction = swapDirection(input_mint, output_mint);
    const slippageBps = resolveSlippageBps(config.management.liquidationSlippageBps);
    const maxImpactPct = Number(config.management.maxSwapPriceImpactPct ?? 6);
    const feeAllowanceLamports = Math.max(0, Math.trunc(Number(config.management.swapFeeAllowanceLamports ?? 20000)));
    const temporarySolDebitLamports = Math.max(0, Math.trunc(Number(config.management.liquidationSolDebitAllowanceLamports ?? 0)));
    const rejectOnMissingPriceImpact = config.management.rejectOnMissingPriceImpact !== false;
    const maxRequotes = Math.max(0, Math.trunc(Number(config.management.maxSwapRequotes ?? 1)));
    const jupiterApiKey = getJupiterApiKey();
    const referralParams = getJupiterReferralParams();

    // ─── Order fetch (re-quotable, with the slippage bound always attached) ───
    const fetchOrder = async () => {
      const search = new URLSearchParams({
        inputMint: input_mint,
        outputMint: output_mint,
        amount: amountStr,
        taker: wallet.publicKey.toString(),
        // Never rely on a provider default: state the bound we are willing to sign.
        slippageBps: String(slippageBps),
      });
      if (referralParams) {
        search.set("referralAccount", referralParams.referralAccount);
        search.set("referralFee", String(referralParams.referralFee));
      }
      const res = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
        headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
      });
      if (!res.ok) {
        throw new Error(`Swap V2 order failed: ${res.status} ${await res.text()}`);
      }
      const o = await res.json();
      if (o.errorCode || o.errorMessage) {
        throw new Error(`Swap V2 order error: ${o.errorMessage || o.errorCode}`);
      }
      return o;
    };

    let order = await fetchOrder();

    // ─── Slippage guard: split high-impact swaps into two smaller chunks ───
    // Meme-token exits (esp. stop-loss dumps into shallow order books) can quote
    // low impact one moment and land far worse a block later. Halving the order
    // meaningfully reduces realized impact on thin liquidity. Bounded to one
    // split (never recurses past _splitDepth 1) to avoid runaway chunking.
    // Each chunk re-enters this whole function and therefore re-runs the full gate.
    const quotedImpactPct = priceImpactPercent(order.priceImpactPct);
    if (_splitDepth === 0 && quotedImpactPct != null && quotedImpactPct > maxImpactPct && Number(amountStr) > 2000) {
      log("swap_warn", `Quoted price impact ${quotedImpactPct.toFixed(2)}% > ${maxImpactPct}% — splitting ${amount} ${input_mint.slice(0, 8)} into 2 chunks`);
      const half = amount / 2;
      const first = await swapToken({ input_mint, output_mint, amount: half, _splitDepth: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const second = await swapToken({ input_mint, output_mint, amount: half, _splitDepth: 1 });
      return mergeSplitSwapResults(first, second);
    }

    // ─── Snapshot the wallet once, before any signing ──────────
    const snapshot = await snapshotWalletTokenState(connection, wallet.publicKey);

    // ─── Simulate + gate. Nothing is signed until this passes. ─
    let decision = null;
    let tx = null;
    for (let attempt = 0; ; attempt++) {
      tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
      const { simulate } = await simulateSwapEffects(
        connection, wallet.publicKey, tx, snapshot, feeAllowanceLamports,
      );
      decision = evaluateSwapSafety({
        direction,
        inputMint: input_mint,
        outputMint: output_mint,
        wallet: wallet.publicKey.toString(),
        inputAmountAtomic: amountStr,
        quotedOutAtomic: order.outAmount,
        slippageBps,
        // Normalized to percent at this boundary — the guard compares against a percent
        // ceiling, and the raw provider fraction would disable that comparison.
        priceImpactPct: quotedImpactPct,
        maxPriceImpactPct: maxImpactPct,
        rejectOnMissingPriceImpact,
        simulate,
        allowances: {
          expectedSolDebitLamports: 0,
          temporarySolDebitLamports,
          maxUnrelatedTokenDebitAtomic: 0,
        },
      });

      if (decision.safe) break;

      log("swap_rejected", JSON.stringify(describeRejection({
        route: order?.routePlan?.[0]?.swapInfo?.label ?? order?.router ?? null,
        provider: order?.router ?? null,
        decision,
        inputMint: input_mint,
        outputMint: output_mint,
        inputAmountAtomic: amountStr,
        quotedOutAtomic: order.outAmount,
        slippageBps,
        simulatedSolDeltaLamports: simulate?.solDeltaLamports ?? null,
        priceImpactPct: quotedImpactPct,
      })));

      if (attempt >= maxRequotes) {
        log("swap_error", `route rejected (${decision.code}) and re-quote budget exhausted: ${decision.reason}`);
        return {
          success: false,
          status: STATUS.FAILED,
          rejected: true,
          reject_code: decision.code,
          reject_reason: decision.reason,
          reject_details: decision.details,
          simulated_sol_delta_lamports: simulate?.solDeltaLamports ?? null,
          quoted_out_atomic: order.outAmount != null ? String(order.outAmount) : null,
          min_out_atomic: decision.minOutAtomic != null ? String(decision.minOutAtomic) : null,
          slippage_bps: slippageBps,
          input_mint,
          output_mint,
          error: `swap route failed execution-safety gate: ${decision.code} — ${decision.reason}`,
        };
      }
      // A different quote may route differently. Limits are NEVER loosened to fit a route.
      log("swap_warn", `re-quoting ${input_mint.slice(0, 8)}→${output_mint.slice(0, 8)} after ${decision.code} (attempt ${attempt + 1}/${maxRequotes})`);
      order = await fetchOrder();
    }

    // ─── Sign only now that the route is proven within bounds ──
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");
    const requestId = order.requestId;

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    // Normalized SOL figures for slippage accounting. Jupiter returns atomic
    // units (lamports); a UI value here can never reach 1000 SOL and an atomic
    // value can never be under 1000 lamports (dust floor $0.10), so the
    // threshold disambiguates safely if the API ever changes units.
    const outIsSol = output_mint === SOL_MINT;
    const toSolUi = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n >= 1000 ? n / 1e9 : n;
    };

    return {
      success: true,
      status: STATUS.SOLD,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      quote_out_sol: outIsSol ? toSolUi(order.outAmount) : null,
      out_sol_ui: outIsSol ? toSolUi(result.outputAmountResult) : null,
      // Execution-safety evidence for telemetry: what bound was enforced and what the
      // pre-sign simulation said the wallet's native SOL delta would be.
      slippage_bps: slippageBps,
      min_out_atomic: decision?.minOutAtomic != null ? String(decision.minOutAtomic) : null,
      simulated_sol_delta_lamports: decision?.details?.netSolCreditLamports != null
        ? String(decision.details.netSolCreditLamports) : null,
      guard_code: decision?.code ?? null,
      price_impact_pct: order.priceImpactPct != null ? Number(order.priceImpactPct) : null,
      usd_in_quote: order.inUsdValue != null ? Number(order.inUsdValue) : null,
      usd_out_quote: order.outUsdValue != null ? Number(order.outUsdValue) : null,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/** Combine two chunked swapToken() results into one. If both chunks failed,
 * reports failure so callers (e.g. swapBaseToSolWithRetry) retry from a fresh
 * balance read — a lone failed chunk otherwise leaves dust behind silently. */
function mergeSplitSwapResults(a, b) {
  const okA = a?.success !== false && !a?.error;
  const okB = b?.success !== false && !b?.error;
  if (!okA && !okB) {
    return { success: false, error: a?.error || b?.error || "both split swaps failed" };
  }
  const sum = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? x + y : (Number.isFinite(x) ? x : (Number.isFinite(y) ? y : null)));
  const avgOf = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? (x + y) / 2 : (Number.isFinite(x) ? x : (Number.isFinite(y) ? y : null)));
  return {
    success: true,
    tx: (okB && b.tx) || (okA && a.tx) || null,
    split_txs: [okA && a.tx, okB && b.tx].filter(Boolean),
    input_mint: a?.input_mint ?? b?.input_mint,
    output_mint: a?.output_mint ?? b?.output_mint,
    amount_in: sum(Number(a?.amount_in), Number(b?.amount_in)),
    amount_out: sum(Number(a?.amount_out), Number(b?.amount_out)),
    quote_out_sol: sum(a?.quote_out_sol, b?.quote_out_sol),
    out_sol_ui: sum(a?.out_sol_ui, b?.out_sol_ui),
    price_impact_pct: avgOf(a?.price_impact_pct, b?.price_impact_pct),
    usd_in_quote: sum(a?.usd_in_quote, b?.usd_in_quote),
    usd_out_quote: sum(a?.usd_out_quote, b?.usd_out_quote),
    referral_account: a?.referral_account ?? b?.referral_account ?? null,
    referral_fee_bps_requested: a?.referral_fee_bps_requested || b?.referral_fee_bps_requested || 0,
  };
}

// Used by tools/limit-exit.js (patient limit-order exits).
export { getWallet, getConnection, getJupiterApiKey };

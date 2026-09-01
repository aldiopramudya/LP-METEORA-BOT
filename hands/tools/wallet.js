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

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  _splitDepth = 0,
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

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    // ─── Slippage guard: split high-impact swaps into two smaller chunks ───
    // Meme-token exits (esp. stop-loss dumps into shallow order books) can quote
    // low impact one moment and land far worse a block later. Halving the order
    // meaningfully reduces realized impact on thin liquidity. Bounded to one
    // split (never recurses past _splitDepth 1) to avoid runaway chunking.
    const quotedImpactPct = order.priceImpactPct != null ? Math.abs(Number(order.priceImpactPct)) * 100 : null;
    const maxImpactPct = Number(config.management.maxSwapPriceImpactPct ?? 6);
    if (_splitDepth === 0 && quotedImpactPct != null && quotedImpactPct > maxImpactPct && Number(amountStr) > 2000) {
      log("swap_warn", `Quoted price impact ${quotedImpactPct.toFixed(2)}% > ${maxImpactPct}% — splitting ${amount} ${input_mint.slice(0, 8)} into 2 chunks`);
      const half = amount / 2;
      const first = await swapToken({ input_mint, output_mint, amount: half, _splitDepth: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const second = await swapToken({ input_mint, output_mint, amount: half, _splitDepth: 1 });
      return mergeSplitSwapResults(first, second);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

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
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      quote_out_sol: outIsSol ? toSolUi(order.outAmount) : null,
      out_sol_ui: outIsSol ? toSolUi(result.outputAmountResult) : null,
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

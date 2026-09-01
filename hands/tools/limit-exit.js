/**
 * Patient exit — Jupiter Trigger (limit) orders for NON-URGENT swap-backs.
 *
 * Motivation (2026-07-14, user-approved "fix #4"): swap-back slippage is the
 * fleet's #1 pure leak (-1.76 SOL tracked in 4 days). Market-selling memecoin
 * exits into thin books pays the spread; a resting limit order at quote+offset
 * RECEIVES it instead. Only used when there is no urgency:
 *   - close reason is not a stop loss, AND position pnl >= 0
 * Emergency exits (SL, negative pnl) keep the market path — speed > price.
 *
 * Flow per exit:
 *   1. quote the full amount via Swap V2 /order (no execute) → fair outAmount
 *   2. place a Trigger order asking outAmount × (1 + offsetPct), expiry N min
 *   3. watcher (2-min loop) — if filled (balance gone) → done, log fill;
 *      after expiry + grace, any remaining balance is market-sold (fallback)
 * Jupiter's keeper auto-closes expired trigger orders and returns funds, so
 * the fallback path always has the tokens back in-wallet by grace time.
 *
 * Kill switch: user-config `limitExitEnabled: false` (config.management).
 * State: limit-orders.json (pending) + limit-orders-history.jsonl (audit).
 */
import fs from "fs";
import { VersionedTransaction } from "@solana/web3.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import { repoPath } from "../repo-root.js";
import { getWallet, getJupiterApiKey, getWalletBalances, swapToken, normalizeMint } from "./wallet.js";

const TRIGGER_API = "https://api.jup.ag/trigger/v1";
const SWAP_V2_API = "https://api.jup.ag/swap/v2";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STATE_FILE = repoPath("limit-orders.json");
const HISTORY_FILE = repoPath("limit-orders-history.jsonl");
const WATCH_INTERVAL_MS = 2 * 60 * 1000;
const EXPIRY_GRACE_MS = 3 * 60 * 1000; // keeper needs a moment to return funds
const DUST_USD = 0.10;

function cfg() {
  const m = config.management || {};
  return {
    enabled: m.limitExitEnabled ?? true,
    offsetPct: Number(m.limitExitOffsetPct ?? 0.3),
    maxWaitMinutes: Number(m.limitExitMaxWaitMinutes ?? 30),
    minUsd: Number(m.limitExitMinUsd ?? 5),
  };
}

function loadPending() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).pending || []; }
  catch { return []; }
}
function savePending(pending) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pending }, null, 2));
}
function history(event) {
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n"); }
  catch { /* audit trail is best-effort */ }
}

async function jupPost(path, body) {
  const res = await fetch(`${TRIGGER_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": getJupiterApiKey() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json.error || json.message || JSON.stringify(json).slice(0, 120)}`);
  return json;
}

/** Quote the full token amount through Swap V2 (order only, never executed). */
async function quoteOutLamports(inputMint, amountAtomic, taker) {
  const search = new URLSearchParams({
    inputMint, outputMint: SOL_MINT, amount: amountAtomic, taker,
  });
  const res = await fetch(`${SWAP_V2_API}/order?${search}`, { headers: { "x-api-key": getJupiterApiKey() } });
  if (!res.ok) throw new Error(`quote failed: ${res.status}`);
  const order = await res.json();
  if (order.errorCode || order.errorMessage) throw new Error(`quote error: ${order.errorMessage || order.errorCode}`);
  return { outLamports: Number(order.outAmount), priceImpactPct: order.priceImpactPct != null ? Number(order.priceImpactPct) : null };
}

/**
 * Try to place a patient limit sell for the wallet's full balance of baseMint.
 * Returns true if an order was placed (caller must then SKIP the market swap),
 * false in every other case (caller falls back to the normal market path).
 */
export async function tryPlaceLimitExit({ baseMint, position, reason }) {
  const c = cfg();
  if (!c.enabled) return false;
  if (process.env.DRY_RUN === "true") return false;
  baseMint = normalizeMint(baseMint);
  if (!baseMint || baseMint === SOL_MINT) return false;

  const wallet = getWallet();
  const balances = await getWalletBalances({});
  const token = balances.tokens?.find((t) => t.mint === baseMint);
  if (!token || !(token.usd >= c.minUsd)) {
    // Jupiter Trigger rejects orders under ~$5 anyway — not worth a resting order.
    return false;
  }

  // Atomic amount for the full balance.
  const { getConnection } = await import("./wallet.js");
  const { PublicKey } = await import("@solana/web3.js");
  const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(baseMint));
  const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
  const makingAmount = Math.floor(token.balance * 10 ** decimals).toString();

  const { outLamports, priceImpactPct } = await quoteOutLamports(baseMint, makingAmount, wallet.publicKey.toString());
  if (!Number.isFinite(outLamports) || outLamports <= 0) return false;
  const takingAmount = Math.floor(outLamports * (1 + c.offsetPct / 100)).toString();
  const expiredAt = Math.floor((Date.now() + c.maxWaitMinutes * 60 * 1000) / 1000);

  const created = await jupPost("/createOrder", {
    inputMint: baseMint,
    outputMint: SOL_MINT,
    maker: wallet.publicKey.toString(),
    payer: wallet.publicKey.toString(),
    params: { makingAmount, takingAmount, expiredAt: String(expiredAt) },
    computeUnitPrice: "auto",
  });
  if (!created.transaction) throw new Error("createOrder returned no transaction");

  const tx = VersionedTransaction.deserialize(Buffer.from(created.transaction, "base64"));
  tx.sign([wallet]);
  const executed = await jupPost("/execute", {
    requestId: created.requestId,
    signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
  });

  const entry = {
    position: position ?? null,
    mint: baseMint,
    symbol: token.symbol || baseMint.slice(0, 8),
    usd_at_placement: token.usd,
    making_amount: makingAmount,
    taking_lamports: takingAmount,
    quote_lamports: String(outLamports),
    quote_price_impact_pct: priceImpactPct,
    offset_pct: c.offsetPct,
    order_tx: executed.signature ?? null,
    order_account: created.order ?? null,
    reason: reason ?? null,
    placed_at: new Date().toISOString(),
    expires_at: new Date(expiredAt * 1000).toISOString(),
  };
  const pending = loadPending();
  pending.push(entry);
  savePending(pending);
  history({ type: "placed", ...entry });
  log("limit_exit", `Patient exit placed: ${entry.symbol} $${token.usd.toFixed(2)} asking quote+${c.offsetPct}% (expires ${c.maxWaitMinutes}min, tx ${entry.order_tx?.slice(0, 8) ?? "?"})`);
  return true;
}

/** Market-sell fallback with small retry — used after an order expires unfilled. */
async function fallbackMarketSell(entry, balance) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await swapToken({ input_mint: entry.mint, output_mint: "SOL", amount: balance }).catch((e) => ({ success: false, error: e.message }));
    if (result && result.success !== false && (result.tx || result.amount_out)) {
      history({ type: "fallback_market_sell", mint: entry.mint, symbol: entry.symbol, attempt, tx: result.tx ?? null, out_sol: result.out_sol_ui ?? null });
      log("limit_exit", `Patient exit expired unfilled — market fallback sold ${entry.symbol} (attempt ${attempt})`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  log("limit_exit_warn", `Fallback market sell FAILED for ${entry.symbol} — token left in wallet, will retry next watcher tick`);
  return false;
}

let _watcherStarted = false;
let _checking = false;

async function checkPending() {
  if (_checking) return;
  _checking = true;
  try {
    let pending = loadPending();
    if (!pending.length) return;
    const balances = await getWalletBalances({});
    if (balances.error) return; // Helius hiccup — try again next tick
    const now = Date.now();
    const keep = [];
    for (const entry of pending) {
      const token = balances.tokens?.find((t) => t.mint === entry.mint);
      const remainingUsd = token?.usd ?? 0;
      if (remainingUsd < DUST_USD) {
        // Tokens gone → order filled (or already swept). Either way: done.
        history({ type: "filled", mint: entry.mint, symbol: entry.symbol, usd_at_placement: entry.usd_at_placement, taking_lamports: entry.taking_lamports });
        log("limit_exit", `Patient exit FILLED: ${entry.symbol} — received asked price (quote+${entry.offset_pct}%) instead of paying market impact`);
        continue;
      }
      const expiresAt = new Date(entry.expires_at).getTime();
      if (now >= expiresAt + EXPIRY_GRACE_MS) {
        const sold = await fallbackMarketSell(entry, token.balance);
        if (!sold) keep.push(entry); // retry the fallback next tick
        continue;
      }
      keep.push(entry); // still resting
    }
    if (keep.length !== pending.length) savePending(keep);
  } catch (e) {
    log("limit_exit_warn", `watcher error: ${e.message}`);
  } finally {
    _checking = false;
  }
}

export function startLimitExitWatcher() {
  if (_watcherStarted) return;
  _watcherStarted = true;
  const t = setInterval(() => { void checkPending(); }, WATCH_INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();
  // One early check on boot so orders left pending across a restart get handled.
  setTimeout(() => { void checkPending(); }, 15_000);
}

// Self-start on import — executor.js imports this module, so the watcher is
// always alive in any process that can place orders.
startLimitExitWatcher();

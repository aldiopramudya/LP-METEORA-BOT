/**
 * liquidation-status — PURE state machine for what happened to a base-token balance (F2).
 *
 * No I/O, no imports. All amounts are plain numbers so the decision surface is
 * unit-testable without a chain.
 *
 * WHY THIS EXISTS (forensic audit):
 *   hands/tools/executor.js decided "nothing left to swap (already sold or dust)" from
 *   `token.usd < 0.10` and returned `{ swapped: attempt > 1 }` — i.e. it reported a
 *   SUCCESSFUL SALE for a balance it never touched. Two consequences:
 *     1. the base token stayed in the wallet, so its ATA stayed open and kept
 *        trapping rent (the audited 0.039201 SOL);
 *     2. `null` USD values (Helius price gap) compare as `null < 0.10 === true`, so a
 *        real, sellable balance was silently classified as dust and never sold.
 *   Dust is not sold. A zero balance is not dust. An unknown price is not dust.
 *   Those are three different states and the code now says which one it is.
 */

export const STATUS = {
  ZERO: "zero",     // balance is exactly 0 -> nothing to sell; the ATA is reclaimable
  SOLD: "sold",     // a liquidation executed AND the balance is now exactly 0
  DUST: "dust",     // nonzero but not economically swappable (or only dust remains)
  RETRY: "retry",   // swap failed but a bounded retry is still worthwhile
  FAILED: "failed", // swap failed and retries are exhausted; balance remains
};

export const ACTION = {
  CLEANUP: "cleanup",         // attempt safe ATA close (F1)
  SWAP: "swap",               // attempt liquidation
  RECORD_DUST: "record_dust", // persist in the dust registry; do NOT burn gas again
  RETRY: "retry",
  GIVE_UP: "give_up",
};

/** Default USD floor below which a swap is not worth its gas. */
export const DEFAULT_DUST_FLOOR_USD = 0.10;

/**
 * Atomic size below which a balance is dust regardless of price. Used only when the
 * USD valuation is unavailable, so an unknown price can never be read as "worthless".
 * 10_000 atomic units is 0.01 of a 6-decimal token / 0.00001 of a 9-decimal token:
 * small enough never to block a real liquidation, large enough that integer dust
 * (1-1000 units left over from rounding) is still recognised as dust.
 */
export const DEFAULT_DUST_FLOOR_ATOMIC = 10000;

const num = (v, d = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Is the USD valuation actually known (as opposed to missing/zero-by-absence)? */
export function priceKnown(usdValue) {
  return usdValue !== null && usdValue !== undefined && usdValue !== "" && Number.isFinite(Number(usdValue));
}

/**
 * Decide whether a nonzero balance is worth spending gas on.
 * An unknown price is treated as UNKNOWN, never as dust: we fall back to an atomic
 * floor so a real balance is still liquidated.
 */
export function isEconomicallySwappable({ balanceAtomic, usdValue, dustFloorUsd = DEFAULT_DUST_FLOOR_USD, dustFloorAtomic = DEFAULT_DUST_FLOOR_ATOMIC } = {}) {
  const bal = num(balanceAtomic, 0);
  if (bal <= 0) return false;
  if (priceKnown(usdValue)) return Number(usdValue) >= num(dustFloorUsd, DEFAULT_DUST_FLOOR_USD);
  return bal > num(dustFloorAtomic, DEFAULT_DUST_FLOOR_ATOMIC);
}

/**
 * Classify one liquidation attempt.
 *
 * @param {object} ctx
 * @param {string|number} ctx.balanceAtomic      balance before the attempt (atomic)
 * @param {number|null}   ctx.usdValue           USD valuation before the attempt (may be null)
 * @param {number}        [ctx.dustFloorUsd]
 * @param {number}        [ctx.dustFloorAtomic]
 * @param {boolean}       [ctx.swapAttempted=false]
 * @param {boolean}       [ctx.swapOk=true]
 * @param {string}        [ctx.swapError]
 * @param {string|number|null} [ctx.postBalanceAtomic]  re-read AFTER a confirmed swap
 * @param {number}        [ctx.attempts=0]
 * @param {number}        [ctx.maxAttempts=3]
 * @returns {{status:string, action:string, reason:string, sellable:boolean, swappable:boolean}}
 */
export function classifyLiquidation(ctx = {}) {
  const bal = num(ctx.balanceAtomic, 0);
  const post = ctx.postBalanceAtomic === null || ctx.postBalanceAtomic === undefined ? null : num(ctx.postBalanceAtomic, null);
  const attempts = num(ctx.attempts, 0);
  const maxAttempts = Math.max(1, num(ctx.maxAttempts, 3));
  const swappable = isEconomicallySwappable(ctx);
  const floorAtomic = num(ctx.dustFloorAtomic, DEFAULT_DUST_FLOOR_ATOMIC);
  const floorUsd = num(ctx.dustFloorUsd, DEFAULT_DUST_FLOOR_USD);

  // ── exact zero: nothing to sell, the account is reclaimable ─────────────
  if (bal <= 0) {
    return { status: STATUS.ZERO, action: ACTION.CLEANUP, reason: "token balance is exactly zero", sellable: false, swappable: false };
  }

  // ── not worth gas: dust, and dust is never "sold" ───────────────────────
  if (!swappable) {
    return {
      status: STATUS.DUST,
      action: ACTION.RECORD_DUST,
      reason: priceKnown(ctx.usdValue)
        ? `balance worth $${Number(ctx.usdValue)} < $${floorUsd} — uneconomic to swap`
        : `balance ${bal} <= atomic dust floor ${floorAtomic} — uneconomic to swap`,
      sellable: false,
      swappable: false,
    };
  }

  // ── a swap was attempted ───────────────────────────────────────────────
  if (ctx.swapAttempted) {
    if (ctx.swapOk === false || ctx.swapError) {
      if (attempts < maxAttempts) {
        return {
          status: STATUS.RETRY,
          action: ACTION.RETRY,
          reason: `swap failed (attempt ${attempts}/${maxAttempts}): ${String(ctx.swapError || "unknown").slice(0, 120)}`,
          sellable: true,
          swappable: true,
        };
      }
      return {
        status: STATUS.FAILED,
        action: ACTION.GIVE_UP,
        reason: `swap failed and retries exhausted (${attempts}/${maxAttempts}): ${String(ctx.swapError || "unknown").slice(0, 120)}`,
        sellable: true,
        swappable: true,
      };
    }
    // swap reported success — only a re-read decides what really happened
    if (post === null) {
      return {
        status: STATUS.RETRY,
        action: ACTION.RETRY,
        reason: "swap reported success but post-swap balance could not be re-read",
        sellable: true,
        swappable: true,
      };
    }
    if (post <= 0) {
      return { status: STATUS.SOLD, action: ACTION.CLEANUP, reason: "swap confirmed and balance is now exactly zero", sellable: false, swappable: false };
    }
    // residual left behind
    if (post <= floorAtomic || (priceKnown(ctx.usdValue) && Number(ctx.usdValue) < floorUsd)) {
      return {
        status: STATUS.DUST,
        action: ACTION.RECORD_DUST,
        reason: `swap left residual dust ${post} (floor ${floorAtomic}) — recording as dust, not sold`,
        sellable: false,
        swappable: false,
      };
    }
    if (attempts < maxAttempts) {
      return {
        status: STATUS.RETRY,
        action: ACTION.RETRY,
        reason: `swap left a meaningful residual ${post}; retrying (attempt ${attempts}/${maxAttempts})`,
        sellable: true,
        swappable: true,
      };
    }
    return {
      status: STATUS.FAILED,
      action: ACTION.GIVE_UP,
      reason: `swap repeatedly left a residual of ${post}; retries exhausted`,
      sellable: true,
      swappable: true,
    };
  }

  // ── no attempt yet: it is worth selling ────────────────────────────────
  return { status: STATUS.RETRY, action: ACTION.SWAP, reason: "sellable balance, no attempt yet", sellable: true, swappable: true };
}

/**
 * Should a mint be retried on the next tick?
 * Dust and terminal failures never retry — that is the fix for the endless
 * pendingSell loop that burned one transaction fee per attempt on unsellable dust.
 */
export function shouldRetry(status) {
  return status === STATUS.RETRY;
}

/** Dust registry entry. Keeps the reason a mint is still nonzero so the bot can explain itself. */
export function dustEntry({ mint, symbol = null, balanceAtomic, decimals = null, usdValue = null, reason = null, now = Date.now() } = {}) {
  return {
    mint,
    symbol,
    balance_atomic: String(balanceAtomic ?? 0),
    decimals,
    usd: priceKnown(usdValue) ? Number(usdValue) : null,
    reason: reason || "uneconomic to swap",
    since: new Date(now).toISOString(),
  };
}

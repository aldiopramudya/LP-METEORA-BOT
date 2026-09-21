// Close/retry invariants shared by the on-chain closer and BIDASK accounting.

export function isExpiredCloseError(error) {
  const text = `${error?.name || ""} ${error?.message || error || ""}`;
  return /TransactionExpired|block[ -]?height(?:\s+has\s+been)?\s+exceeded|blockheight exceeded|expired/i.test(text);
}

export function dlmmLiquidityState(position) {
  const data = position?.positionData;
  if (!data || !Array.isArray(data.positionBinData)) return "unknown";
  try {
    return data.positionBinData.some((bin) => BigInt(String(bin?.positionLiquidity ?? 0)) > 0n)
      ? "positive"
      : "zero";
  } catch {
    return "unknown";
  }
}

export async function sendCloseWithLiquidityRecheck({ send, readPosition, onReadError }) {
  try {
    return { signature: await send(), partial: false };
  } catch (error) {
    if (!isExpiredCloseError(error)) throw error;

    let state = "unknown";
    try {
      state = dlmmLiquidityState(await readPosition());
    } catch (readError) {
      onReadError?.(readError);
    }
    if (state !== "zero") throw error;

    return { signature: null, partial: true };
  }
}

export function positionLiquidityIsZero(position) {
  return Number(position?.amtX) === 0 && Number(position?.amtY) === 0;
}

export function rememberCloseAttempt(position, reason, walletBefore) {
  if (!position.closing || typeof position.closing !== "object") {
    position.closing = { reason, walletBefore };
  }
  return position.closing;
}

export function applyCloseToDaily(day, realized, basis) {
  if (basis === "est") return false;
  day.realizedSol += realized;
  return true;
}

/**
 * The BIDASK close state machine. A persisted attempt always wins over a new
 * decision, which keeps both its reason and its pre-close wallet baseline.
 */
export async function processPositionClose({
  position,
  live,
  decide,
  onDecision,
  readWallet,
  persist,
  close,
  isFailed,
  account,
}) {
  let attempt = position.closing;
  let resumed = Boolean(attempt);

  if (!attempt) {
    const decision = decide();
    onDecision?.(decision);
    if (!decision.why) return { handled: false, decision };

    const walletBefore = position.dry ? null : await readWallet();
    attempt = rememberCloseAttempt(position, decision.why, walletBefore);
    // The baseline must reach disk before the long-running close command starts.
    persist();
  }

  const result = await close(attempt.reason);
  if (isFailed(result)) return { handled: true, closed: false, resumed, result };

  await account({
    live,
    reason: attempt.reason,
    result,
    walletBefore: attempt.walletBefore,
  });
  return { handled: true, closed: true, resumed, result };
}

/** The wallet-delta/fallback portion of BIDASK close accounting. */
export async function settleCloseAccounting({
  day,
  position,
  live,
  result,
  walletBefore,
  readWallet,
  readTokenBalance,
  pause,
  onFallback,
}) {
  const round = (value) => +Number(value).toFixed(4);
  const estimate = position.dry
    ? round(live.valueSol - position.deployedSol - 0.003 * (live.valueSol - live.amtY) - 0.002)
    : round(live.valueSol * 0.97 - position.deployedSol);

  let realized = estimate;
  let basis = position.dry ? "dry" : "est";
  if (!position.dry && walletBefore != null && position.costSol != null) {
    await pause();
    const walletAfter = await readWallet();
    if (walletAfter != null) {
      const walletDelta = round(walletAfter - walletBefore - position.costSol);
      const tokenLeft = position.mint ? await readTokenBalance(position.mint) : 0;
      const sane = walletDelta >= -1.05 * position.deployedSol && walletDelta <= 1.0 * position.deployedSol;
      if (sane && (result.auto_swapped === true || tokenLeft === 0)) {
        realized = walletDelta;
        basis = "wallet";
      } else {
        onFallback?.({ walletDelta, tokenLeft, estimate, result });
      }
    }
  }

  const countsTowardDaily = applyCloseToDaily(day, realized, basis);
  return { realized, basis, countsTowardDaily };
}

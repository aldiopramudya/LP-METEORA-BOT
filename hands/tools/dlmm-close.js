import { sendCloseWithLiquidityRecheck } from "../../lib/close-safety.mjs";

/** Production transaction boundary for DLMM close/remove-liquidity sends. */
export async function sendDlmmCloseTransaction({
  connection,
  tx,
  wallet,
  pool,
  positionPubKey,
  sendTransaction,
  onReadError,
  onPartial,
}) {
  const outcome = await sendCloseWithLiquidityRecheck({
    send: () => sendTransaction(connection, tx, [wallet]),
    readPosition: () => pool.getPosition(positionPubKey),
    onReadError,
  });
  if (outcome.partial) onPartial?.();
  return outcome.signature;
}

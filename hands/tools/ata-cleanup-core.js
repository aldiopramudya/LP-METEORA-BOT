/**
 * ata-cleanup-core — PURE decision layer for reclaiming empty token-account rent (F1).
 *
 * No I/O, no imports, no chain access: the buffer parsers and the eligibility gate take
 * plain values and Buffers so the whole surface is unit-testable offline.
 *
 * WHY THIS EXISTS (forensic audit):
 *   20 base-token ATAs were left open with a zero balance, holding 39,200,886 lamports
 *   (0.039201 SOL) of reclaimable rent — 115% of the audited wallet result and 754% of
 *   its net economic profit. A repo-wide search found no closeAccount / rent-reclaim
 *   logic anywhere: every deploy created an ATA and nothing ever closed one.
 *
 * SAFETY POSTURE: this gate fails closed. Anything it does not positively recognise as
 * safe to close is skipped with a reason. It never closes an account it is unsure about,
 * and it never closes an account that still holds a balance, belongs to someone else,
 * is wSOL, backs an active position, or has a liquidation in flight.
 */

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** SPL Token / Token-2022 `CloseAccount` instruction tag (identical in both programs). */
export const CLOSE_ACCOUNT_IX_TAG = 9;

/** Token-2022 account layout: 165-byte base + AccountType byte, TLV starts at 166. */
export const TOKEN_2022_TLV_OFFSET = 166;

/** Token-2022 extension type ids we can name. Unknown ids are treated as unsafe. */
export const EXTENSION_NAMES = {
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "GroupMemberPointer",
};

/**
 * Account-side extensions that do NOT block an owner-initiated close of a zero-balance
 * account. Anything not listed here (including anything unknown) forces a skip, because
 * guessing wrong on Token-2022 means signing a transaction that either fails on-chain or
 * does something we did not model.
 *
 *   2  TransferFeeAmount      safe only when withheld_amount == 0 (checked separately)
 *   7  ImmutableOwner         does not restrict the owner's ability to close
 *   8  MemoTransfer           affects incoming transfers, not close
 *   11 CpiGuard               restricts CPI, not an owner close
 *   13 NonTransferableAccount non-transferable is unrelated to closing
 *   15 TransferHookAccount    hooks fire on transfer, not on close
 */
export const CLOSE_SAFE_ACCOUNT_EXTENSIONS = new Set([2, 7, 8, 11, 13, 15]);

/** Extensions that need an extra data check before the account can be considered safe. */
export const EXTENSION_WITH_DATA_CHECK = new Set([2]);

export const SKIP = {
  OK: "OK",
  NOT_OWNED: "NOT_OWNED",
  NOT_ZERO_BALANCE: "NOT_ZERO_BALANCE",
  WSOL_ACCOUNT: "WSOL_ACCOUNT",
  ACTIVE_POSITION_MINT: "ACTIVE_POSITION_MINT",
  PENDING_LIQUIDATION: "PENDING_LIQUIDATION",
  OUTSIDE_LIFECYCLE: "OUTSIDE_LIFECYCLE",
  UNKNOWN_TOKEN_PROGRAM: "UNKNOWN_TOKEN_PROGRAM",
  UNSAFE_EXTENSION: "UNSAFE_EXTENSION",
  WITHHELD_TRANSFER_FEE: "WITHHELD_TRANSFER_FEE",
  MALFORMED_ACCOUNT: "MALFORMED_ACCOUNT",
};

/**
 * Walk the Token-2022 TLV region of a token ACCOUNT (not a mint) and return the
 * extensions it carries. Pure: takes a Buffer/Uint8Array, returns a description.
 *
 * @returns {{extensions:{type:number,name:string,start:number,length:number,data:Uint8Array}[], malformed:boolean, reason?:string}}
 */
export function parseToken2022AccountExtensions(buffer, { offset = TOKEN_2022_TLV_OFFSET } = {}) {
  const out = { extensions: [], malformed: false };
  if (!buffer || typeof buffer.length !== "number") {
    return { ...out, malformed: true, reason: "no account data" };
  }
  const len = buffer.length;
  if (len <= 165) {
    // No AccountType/TLV region at all — a bare SPL-Token-shaped account.
    return out;
  }
  let o = offset;
  const readU16 = (i) => buffer[i] | (buffer[i + 1] << 8);
  const readU64 = (i) => {
    let v = 0n;
    for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(buffer[i + k] & 0xff);
    return v;
  };
  while (o + 4 <= len) {
    const type = readU16(o);
    if (type === 0) break; // uninitialized padding marks the end of the TLV region
    const length = readU16(o + 2);
    const start = o + 4;
    if (start + length > len) {
      return { ...out, malformed: true, reason: `extension ${type} overruns account data` };
    }
    // A zero-length payload is legal: ImmutableOwner, MemoTransfer-free variants,
    // NonTransferableAccount and friends carry no data. Only an overrun is malformed.
    const data = buffer.subarray ? buffer.subarray(start, start + length) : buffer.slice(start, start + length);
    out.extensions.push({
      type,
      name: EXTENSION_NAMES[type] || `Unknown(${type})`,
      start,
      length,
      data,
      // TransferFeeAmount.withheld_amount is the leading u64
      withheldAmount: type === 2 ? readU64(start) : null,
    });
    o = start + length;
  }
  return out;
}

/**
 * Gate: may this token account be closed right now, safely?
 *
 * @param {object} ctx
 * @param {string} ctx.address                      token account pubkey
 * @param {string} ctx.mint
 * @param {string} ctx.owner                        on-chain owner of the token account
 * @param {string} ctx.tokenProgram                 program that owns the account
 * @param {string|number} ctx.balanceAtomic         token balance in atomic units
 * @param {string} ctx.wallet                       configured wallet (must be the owner)
 * @param {Array<{type:number,name:string,withheldAmount?:bigint|null}>} [ctx.extensions]
 * @param {boolean} [ctx.malformed]
 * @param {string[]} [ctx.activePositionMints]      mints backing a live LP position
 * @param {string[]} [ctx.pendingLiquidationMints]  mints with a liquidation in flight
 * @param {string[]|null} [ctx.allowedMints]        when an array, ONLY these mints may be closed
 *        (the bot's own lifecycle); pass null/undefined to lift the filter explicitly.
 * @param {string|number} [ctx.rentLamports]        rent currently held (informational)
 * @returns {{eligible:boolean, code:string, reason:string, rentLamports:string|null}}
 */
export function evaluateAtaClosability(ctx = {}) {
  const rent = ctx.rentLamports === null || ctx.rentLamports === undefined ? null : String(ctx.rentLamports);
  const deny = (code, reason) => ({ eligible: false, code, reason, rentLamports: rent });

  if (!ctx.address || !ctx.mint) return deny(SKIP.MALFORMED_ACCOUNT, "account or mint address missing");
  if (ctx.malformed) return deny(SKIP.MALFORMED_ACCOUNT, "token account data could not be parsed");

  // 1. must belong to the configured wallet
  if (!ctx.wallet || String(ctx.owner) !== String(ctx.wallet)) {
    return deny(SKIP.NOT_OWNED, `token account owner ${String(ctx.owner).slice(0, 12)}… is not the configured wallet`);
  }

  // 2. must be a token program we understand
  const prog = String(ctx.tokenProgram || "");
  if (prog !== TOKEN_PROGRAM_ID && prog !== TOKEN_2022_PROGRAM_ID) {
    return deny(SKIP.UNKNOWN_TOKEN_PROGRAM, `token program ${prog.slice(0, 14) || "(missing)"} is not SPL Token or Token-2022`);
  }

  // 3. never close wSOL — it is the native-SOL side of the bot's own deploy/close flow
  if (String(ctx.mint) === SOL_MINT) {
    return deny(SKIP.WSOL_ACCOUNT, "wrapped SOL account — kept open for the deploy/close flow");
  }

  // 4. balance must be exactly zero
  const bal = Number(ctx.balanceAtomic);
  if (!Number.isFinite(bal)) return deny(SKIP.MALFORMED_ACCOUNT, "token balance is not a number");
  if (bal !== 0) {
    return deny(SKIP.NOT_ZERO_BALANCE, `token balance is ${bal}, not zero`);
  }

  // 5. must not back an active LP position
  const active = new Set((ctx.activePositionMints || []).map(String));
  if (active.has(String(ctx.mint))) {
    return deny(SKIP.ACTIVE_POSITION_MINT, "mint backs an active LP position");
  }

  // 6. no liquidation may be in flight for this mint
  const pending = new Set((ctx.pendingLiquidationMints || []).map(String));
  if (pending.has(String(ctx.mint))) {
    return deny(SKIP.PENDING_LIQUIDATION, "a liquidation is pending for this mint");
  }

  // 6b. restrict to the bot's own lifecycle when a filter is supplied (requirement F1.6).
  // An empty array is a filter that matches nothing — fail closed rather than sweep
  // accounts this bot never created.
  if (Array.isArray(ctx.allowedMints) && !ctx.allowedMints.map(String).includes(String(ctx.mint))) {
    return deny(SKIP.OUTSIDE_LIFECYCLE, "mint is not part of this bot's position/dust lifecycle");
  }

  // 7. Token-2022: only close accounts whose extensions we positively recognise as safe
  if (prog === TOKEN_2022_PROGRAM_ID) {
    const exts = ctx.extensions || [];
    for (const e of exts) {
      if (!CLOSE_SAFE_ACCOUNT_EXTENSIONS.has(e.type)) {
        return deny(SKIP.UNSAFE_EXTENSION, `Token-2022 extension ${e.name} is not known-safe to close — skipping`);
      }
      if (EXTENSION_WITH_DATA_CHECK.has(e.type) && e.withheldAmount != null && e.withheldAmount !== 0n) {
        return deny(SKIP.WITHHELD_TRANSFER_FEE, `${e.name} still withholds ${e.withheldAmount} — must be zero to close`);
      }
    }
  }

  return { eligible: true, code: SKIP.OK, reason: "eligible for rent reclamation", rentLamports: rent };
}

/** Split a list into fixed-size chunks (batching multiple closes into one transaction). */
export function chunkArray(arr, size) {
  const n = Math.max(1, Math.trunc(Number(size) || 1));
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Roll a batch of per-account results into one summary for logging/telemetry. */
export function summarizeCleanup(results = []) {
  const s = { checked: results.length, eligible: 0, closed: 0, skipped: 0, failed: 0, recoveredLamports: 0n, skipReasons: {} };
  for (const r of results) {
    if (r?.eligible) s.eligible++;
    if (r?.closed) {
      s.closed++;
      try { s.recoveredLamports += BigInt(r.rentLamports ?? 0); } catch { /* informational only */ }
    } else if (r?.eligible) {
      s.failed++;
    } else {
      s.skipped++;
      const k = r?.code || "UNKNOWN";
      s.skipReasons[k] = (s.skipReasons[k] || 0) + 1;
    }
  }
  return { ...s, recoveredLamports: s.recoveredLamports.toString(), recoveredSol: Number(s.recoveredLamports) / 1e9 };
}

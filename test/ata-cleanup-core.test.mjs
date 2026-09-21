/**
 * F1 — empty-token-account rent reclamation tests (pure eligibility gate + TLV parser).
 *
 * No RPC, no network, no chain, no funds. The I/O layer (./ata-cleanup.js) is a thin
 * wrapper around these decisions and is never exercised against a live chain here.
 *
 * The regression anchor is the forensic audit: 20 empty base-token ATAs held
 * 39,200,886 lamports (0.039201 SOL) of reclaimable rent — 115% of the audited wallet
 * result — because nothing in the repo had ever closed a token account.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_SAFE_ACCOUNT_EXTENSIONS,
  SKIP,
  SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  chunkArray,
  evaluateAtaClosability,
  parseToken2022AccountExtensions,
  summarizeCleanup,
} from "../hands/tools/ata-cleanup-core.js";

const WALLET = "AP5rGXwFcddV1iMtxnqRFZ51VjVxLmRjBvymDP9377ip";
const OTHER_WALLET = "9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp";
const MINT = "2pouN3by7twkiZGy5aEKYUpf78ALDpKRTNu2WsQkpkqt";
const OTHER_MINT = "MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump";
const ATA = "31tXov5gXMDtyANSM7zALN3tcAi6bJRH8LfND6BHwMFr";

/** Baseline: the plain happy case — own wallet, zero balance, SPL Token. */
function ctx(over = {}) {
  return {
    address: ATA,
    mint: MINT,
    owner: WALLET,
    tokenProgram: TOKEN_PROGRAM_ID,
    balanceAtomic: 0,
    wallet: WALLET,
    rentLamports: 2039280,
    extensions: [],
    malformed: false,
    activePositionMints: [],
    pendingLiquidationMints: [],
    ...over,
  };
}

// ─────────────────────────── the happy case ───────────────────────────

test("F1: a zero-balance SPL token account owned by the wallet IS eligible", () => {
  const v = evaluateAtaClosability(ctx());
  assert.equal(v.eligible, true, v.reason);
  assert.equal(v.code, SKIP.OK);
  assert.equal(v.rentLamports, "2039280");
});

// ───────────────────────── each safety condition ─────────────────────────

test("F1: a nonzero token account is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ balanceAtomic: 1 }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.NOT_ZERO_BALANCE);
  assert.match(v.reason, /not zero/);
});

test("F1: the audit's real dust residual (balance 4) still blocks the close", () => {
  const v = evaluateAtaClosability(ctx({ balanceAtomic: 4 }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.NOT_ZERO_BALANCE);
});

test("F1: an account owned by someone else is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ owner: OTHER_WALLET }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.NOT_OWNED);
});

test("F1: a mint backing an active LP position is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ activePositionMints: [MINT] }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.ACTIVE_POSITION_MINT);
  // a different active mint must not block this one
  assert.equal(evaluateAtaClosability(ctx({ activePositionMints: [OTHER_MINT] })).eligible, true);
});

test("F1: a mint with a liquidation in flight is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ pendingLiquidationMints: [MINT] }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.PENDING_LIQUIDATION);
});

test("F1: the wSOL account is NEVER closed, even when empty", () => {
  const v = evaluateAtaClosability(ctx({ mint: SOL_MINT, balanceAtomic: 0 }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.WSOL_ACCOUNT);
  assert.match(v.reason, /wrapped SOL/);
});

test("F1: an unknown token program is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ tokenProgram: "SomeOtherProgram11111111111111111111111111" }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.UNKNOWN_TOKEN_PROGRAM);
});

test("F1: an unparseable account is NOT closed", () => {
  const v = evaluateAtaClosability(ctx({ malformed: true }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.MALFORMED_ACCOUNT);
});

test("F1: a missing address/mint is NOT closed", () => {
  assert.equal(evaluateAtaClosability(ctx({ address: null })).code, SKIP.MALFORMED_ACCOUNT);
  assert.equal(evaluateAtaClosability(ctx({ mint: null })).code, SKIP.MALFORMED_ACCOUNT);
});

test("F1: a non-numeric balance is NOT closed", () => {
  assert.equal(evaluateAtaClosability(ctx({ balanceAtomic: "abc" })).code, SKIP.MALFORMED_ACCOUNT);
});

// ───────────────────────── lifecycle restriction (F1.6) ─────────────────────────

test("F1: a mint outside the bot's lifecycle is NOT closed when a filter is supplied", () => {
  const v = evaluateAtaClosability(ctx({ allowedMints: [OTHER_MINT] }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.OUTSIDE_LIFECYCLE);
});

test("F1: an empty lifecycle filter closes nothing (fails closed)", () => {
  const v = evaluateAtaClosability(ctx({ allowedMints: [] }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.OUTSIDE_LIFECYCLE);
});

test("F1: no filter means no lifecycle restriction (an explicit opt-in)", () => {
  assert.equal(evaluateAtaClosability(ctx({ allowedMints: undefined })).eligible, true);
  assert.equal(evaluateAtaClosability(ctx({ allowedMints: null })).eligible, true);
  assert.equal(evaluateAtaClosability(ctx({ allowedMints: [MINT] })).eligible, true);
});

// ─────────────────────────── Token-2022 handling ───────────────────────────

/** Build a Token-2022 token-account buffer: 165-byte base + AccountType + TLV entries. */
function t22Account(entries = []) {
  const head = Buffer.alloc(166);
  head[165] = 2; // AccountType::Account
  const parts = [head];
  for (const e of entries) {
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    const tlv = Buffer.alloc(4 + data.length);
    tlv.writeUInt16LE(e.type, 0);
    tlv.writeUInt16LE(data.length, 2);
    data.copy(tlv, 4);
    parts.push(tlv);
  }
  return Buffer.concat(parts);
}

test("F1: a Token-2022 account with a known-safe extension set is eligible", () => {
  // ImmutableOwner(7) + MemoTransfer(8) + CpiGuard(11) — all close-safe.
  const parsed = parseToken2022AccountExtensions(t22Account([
    { type: 7 }, { type: 8, data: [1] }, { type: 11, data: [1] },
  ]));
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.extensions.map((e) => e.name), ["ImmutableOwner", "MemoTransfer", "CpiGuard"]);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions }));
  assert.equal(v.eligible, true, v.reason);
});

test("F1: an unsupported Token-2022 extension safely skips instead of guessing", () => {
  const parsed = parseToken2022AccountExtensions(t22Account([{ type: 5, data: Buffer.alloc(64) }]));
  assert.deepEqual(parsed.extensions.map((e) => e.name), ["ConfidentialTransferAccount"]);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.UNSAFE_EXTENSION);
  assert.match(v.reason, /ConfidentialTransferAccount/);
});

test("F1: an UNKNOWN Token-2022 extension id also skips (unknown is not assumed safe)", () => {
  const parsed = parseToken2022AccountExtensions(t22Account([{ type: 4242, data: [1, 2, 3] }]));
  assert.deepEqual(parsed.extensions.map((e) => e.name), ["Unknown(4242)"]);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.UNSAFE_EXTENSION);
});

test("F1: withheld transfer fees block the close", () => {
  const withheld = Buffer.alloc(8);
  withheld.writeBigUInt64LE(500n, 0);
  const parsed = parseToken2022AccountExtensions(t22Account([{ type: 2, data: withheld }]));
  assert.equal(parsed.extensions[0].withheldAmount, 500n);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions }));
  assert.equal(v.eligible, false);
  assert.equal(v.code, SKIP.WITHHELD_TRANSFER_FEE);
});

test("F1: a zero withheld amount permits the close", () => {
  const parsed = parseToken2022AccountExtensions(t22Account([{ type: 2, data: Buffer.alloc(8) }]));
  assert.equal(parsed.extensions[0].withheldAmount, 0n);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions }));
  assert.equal(v.eligible, true, v.reason);
});

test("F1: the close-safe extension allow-list is a fixed, auditable set", () => {
  assert.deepEqual([...CLOSE_SAFE_ACCOUNT_EXTENSIONS].sort((a, b) => a - b), [2, 7, 8, 11, 13, 15]);
});

test("F1: extension parsing is conservative on malformed data", () => {
  // An extension whose declared length overruns the buffer.
  const bad = Buffer.alloc(166 + 8);
  bad[165] = 2;
  bad.writeUInt16LE(7, 166);
  bad.writeUInt16LE(999, 168);
  const parsed = parseToken2022AccountExtensions(bad);
  assert.equal(parsed.malformed, true);
  assert.match(String(parsed.reason), /overruns/);
  const v = evaluateAtaClosability(ctx({ tokenProgram: TOKEN_2022_PROGRAM_ID, extensions: parsed.extensions, malformed: parsed.malformed }));
  assert.equal(v.eligible, false);
});

test("F1: a bare SPL-shaped account has no extensions and is not malformed", () => {
  const parsed = parseToken2022AccountExtensions(Buffer.alloc(165));
  assert.deepEqual(parsed.extensions, []);
  assert.equal(parsed.malformed, false);
});

test("F1: the TLV walk stops at the uninitialized terminator", () => {
  const a = t22Account([{ type: 7 }]);
  const padded = Buffer.concat([a, Buffer.alloc(16)]); // zero type == terminator
  const parsed = parseToken2022AccountExtensions(padded);
  assert.deepEqual(parsed.extensions.map((e) => e.name), ["ImmutableOwner"]);
  assert.equal(parsed.malformed, false);
});

test("F1: a missing buffer is reported as malformed, not as 'no extensions'", () => {
  assert.equal(parseToken2022AccountExtensions(null).malformed, true);
  assert.equal(parseToken2022AccountExtensions(undefined).malformed, true);
});

// ─────────────────────────── idempotency ───────────────────────────

test("F1: evaluating the same account twice gives an identical verdict (idempotent)", () => {
  const c = ctx();
  const a = evaluateAtaClosability(c);
  const b = evaluateAtaClosability(c);
  assert.deepEqual(a, b);
});

test("F1: a second sweep over an already-closed set reports no failures", () => {
  // First pass: two eligible accounts get closed. Second pass sees them gone, so the
  // same candidate input yields no new closes and, crucially, no failures.
  const first = summarizeCleanup([
    { eligible: true, closed: true, rentLamports: "2039280" },
    { eligible: true, closed: true, rentLamports: "1855569" },
  ]);
  assert.equal(first.closed, 2);
  assert.equal(first.failed, 0);
  assert.equal(first.recoveredLamports, "3894849");
  assert.equal(first.recoveredSol, 0.003894849);

  const second = summarizeCleanup([]);
  assert.deepEqual(second, {
    checked: 0, eligible: 0, closed: 0, skipped: 0, failed: 0,
    recoveredLamports: "0", skipReasons: {}, recoveredSol: 0,
  });
});

test("F1: a skipped account is counted as skipped, never as recovered", () => {
  const s = summarizeCleanup([
    { eligible: true, closed: true, rentLamports: "2039280" },
    { eligible: false, closed: false, code: SKIP.NOT_ZERO_BALANCE },
    { eligible: false, closed: false, code: SKIP.NOT_ZERO_BALANCE },
    { eligible: true, closed: false, code: "TX_FAILED" },
  ]);
  assert.equal(s.checked, 4);
  assert.equal(s.closed, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipReasons[SKIP.NOT_ZERO_BALANCE], 2);
  assert.equal(s.recoveredLamports, "2039280");
});

// ─────────────────────────── batching ───────────────────────────

test("F1: eligible accounts are batched, and batching never drops any", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const chunks = chunkArray(items, 8);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [8, 8, 4]);
  assert.deepEqual(chunks.flat(), items);
});

test("F1: a nonsensical batch size still processes every account", () => {
  assert.deepEqual(chunkArray([1, 2, 3], 0), [[1], [2], [3]]);
  assert.deepEqual(chunkArray([1, 2, 3], -5), [[1], [2], [3]]);
  assert.deepEqual(chunkArray([], 8), []);
});

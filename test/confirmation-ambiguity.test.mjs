import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// These regressions exercise the production implementations, but the repository's
// dependency-free test environment intentionally does not install the Solana SDK.
// Load only the relevant function declarations and provide the tiny transaction/key
// surface used by these tests; importing either production module would eagerly load
// all of its on-chain dependencies before any pure reconciliation logic could run.
let nextPublicKey = 0;
class PublicKey {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}
class Transaction {
  constructor() {
    this.instructions = [];
    this.feePayer = null;
    this.recentBlockhash = undefined;
    this.signature = null;
    this.signatures = [];
  }
  add(instruction) { this.instructions.push(instruction); return this; }
  addSignature(publicKey, signature) {
    this.signature = signature;
    this.signatures.push({ publicKey, signature });
  }
}
const Keypair = {
  generate() {
    const publicKey = new PublicKey(`test-public-key-${++nextPublicKey}`);
    return { publicKey };
  },
};

function sourceSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `production source is missing ${start}`);
  assert.notEqual(to, -1, `production source is missing boundary ${end}`);
  return source.slice(from, to).replace(/\bexport\s+/g, "");
}

function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) {
      carry += digits[index] * 256;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  const firstNonzero = bytes.findIndex((byte) => byte !== 0);
  if (firstNonzero < 0) return "1".repeat(bytes.length);
  let encoded = "1".repeat(firstNonzero);
  for (let index = digits.length - 1; index >= 0; index--) encoded += alphabet[digits[index]];
  return encoded;
}

const ataSource = readFileSync(new URL("../hands/tools/ata-cleanup.js", import.meta.url), "utf8");
const ataImplementations = [
  sourceSection(ataSource, "export function isAmbiguousAtaConfirmationError", "function resolveOwner"),
  sourceSection(ataSource, "function rebuildAtaCloseTransaction", "/**\n * Reclaim rent"),
  sourceSection(ataSource, "export async function sendAtaCloseWithReconciliation", "/**\n * Best-effort cleanup"),
].join("\n");
const {
  isAmbiguousAtaConfirmationError,
  partitionAtaRetryAfterAmbiguous,
  reconcileAtaCloseCandidates,
  sendAtaCloseWithReconciliation,
} = new Function(
  "PublicKey", "Transaction", "sendAndConfirmTransaction", "log",
  `${ataImplementations}\nreturn { isAmbiguousAtaConfirmationError, partitionAtaRetryAfterAmbiguous, reconcileAtaCloseCandidates, sendAtaCloseWithReconciliation };`,
)(PublicKey, Transaction, async () => { throw new Error("unexpected default sender"); }, () => {});

async function sendDlmmCloseTransaction({
  connection, tx, wallet, pool, positionPubKey, sendTransaction, onReadError, onPartial,
}) {
  try {
    return await sendTransaction(connection, tx, [wallet]);
  } catch (sendError) {
    try {
      const position = await pool.getPosition(positionPubKey);
      const bins = position?.positionData?.positionBinData;
      const liquidity = Array.isArray(bins)
        ? bins.reduce((total, bin) => total + BigInt(bin?.positionLiquidity?.toString?.() ?? 0), 0n)
        : null;
      if (liquidity === 0n) {
        onPartial?.();
        return null;
      }
    } catch (readError) {
      onReadError?.(readError);
    }
    throw sendError;
  }
}

const dlmmSource = readFileSync(new URL("../hands/tools/dlmm.js", import.meta.url), "utf8");
const dlmmImplementations = [
  sourceSection(dlmmSource, "export function isAmbiguousDlmmConfirmationError", "function dlmmPositionLiquidity"),
  sourceSection(dlmmSource, "async function readAccountDataSnapshot", "// Sums actual network fee"),
].join("\n");
const {
  accountDataChanged,
  isAmbiguousDlmmConfirmationError,
  sendDlmmClaimTransactionWithReconciliation,
  sendDlmmCloseWithAccountReconciliation,
  sendDlmmTransactionWithReconciliation,
} = new Function(
  "bs58", "sendAndConfirmTransaction", "sendDlmmCloseTransaction",
  `${dlmmImplementations}\nreturn { accountDataChanged, isAmbiguousDlmmConfirmationError, sendDlmmClaimTransactionWithReconciliation, sendDlmmCloseWithAccountReconciliation, sendDlmmTransactionWithReconciliation };`,
)(
  { encode: (bytes) => encodeBase58(bytes) },
  async () => { throw new Error("unexpected default sender"); },
  sendDlmmCloseTransaction,
);

const expired = new Error("Transaction was not confirmed before block height exceeded");
const wrappedExpired = new Error("Transaction expired: block height has been exceeded");
const confirmationExpired = new Error("confirmation expired before the transaction could be confirmed");

test("ATA cleanup classifies expiry and reconciles closed, open, and unknown accounts", async () => {
  assert.equal(isAmbiguousAtaConfirmationError(expired), true);
  assert.equal(isAmbiguousAtaConfirmationError(wrappedExpired), true);
  assert.equal(isAmbiguousAtaConfirmationError(new Error("custom program error: 0x1")), false);

  const candidates = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((keypair) => ({
    address: keypair.publicKey.toString(),
  }));
  const known = await reconcileAtaCloseCandidates({
    getMultipleAccountsInfo: async () => [null, { data: Buffer.alloc(0) }],
  }, candidates);
  assert.deepEqual(known.closed, [candidates[0]]);
  assert.deepEqual(known.open, [candidates[1]]);
  assert.deepEqual(known.unknown, [candidates[2]]);
  assert.deepEqual(partitionAtaRetryAfterAmbiguous(expired, known), {
    landed: [candidates[0]],
    retry: [candidates[1]],
    unresolved: [candidates[2]],
  }, "only a still-open account whose original blockhash expired is safe to retry");

  const timeout = new Error("timed out awaiting confirmation");
  assert.deepEqual(partitionAtaRetryAfterAmbiguous(timeout, known), {
    landed: [candidates[0]],
    retry: [],
    unresolved: [candidates[1], candidates[2]],
  }, "a transaction that could still land must never get a replacement close");

  const unavailable = await reconcileAtaCloseCandidates({
    getMultipleAccountsInfo: async () => { throw new Error("RPC unavailable"); },
  }, candidates);
  assert.deepEqual(unavailable, { closed: [], open: [], unknown: candidates });
});

test("ATA close does not resend when an expired confirmation already landed", async () => {
  const candidate = { address: Keypair.generate().publicKey.toString(), mint: "mint", rentLamports: 1 };
  let sends = 0;
  const result = await sendAtaCloseWithReconciliation(
    {
      simulateTransaction: async () => ({ value: { err: null } }),
      getMultipleAccountsInfo: async () => [null],
    },
    new Transaction(),
    [],
    candidate,
    [],
    { sendTransaction: async () => { sends++; throw expired; } },
  );
  assert.equal(result.closed, true);
  assert.equal(result.confirmation_reconciled, true);
  assert.equal(sends, 1, "a landed close must not execute twice");
});

test("ATA close retries only after blockheight expiry proves the account is still open", async () => {
  const candidate = { address: Keypair.generate().publicKey.toString(), mint: "mint", rentLamports: 1 };
  let sends = 0;
  const signatures = [];
  const sentTransactions = [];
  const simulatedBlockhashes = [];
  const result = await sendAtaCloseWithReconciliation(
    {
      simulateTransaction: async (tx) => {
        simulatedBlockhashes.push(tx.recentBlockhash ?? null);
        return { value: { err: null } };
      },
      getMultipleAccountsInfo: async () => [{ data: Buffer.alloc(0) }],
    },
    new Transaction(),
    [],
    candidate,
    signatures,
    {
      sendTransaction: async (_connection, tx) => {
        sends++;
        sentTransactions.push(tx);
        if (sends === 1) {
          tx.recentBlockhash = "expired-blockhash";
          throw expired;
        }
        return "retry-signature";
      },
    },
  );
  assert.equal(result.closed, true);
  assert.equal(result.tx_signature, "retry-signature");
  assert.deepEqual(signatures, ["retry-signature"]);
  assert.equal(sends, 2);
  assert.notEqual(sentTransactions[1], sentTransactions[0], "retry must use a fresh transaction object");
  assert.deepEqual(simulatedBlockhashes, [null, null], "expired blockhash must not leak into retry simulation");
});

test("ATA close does not retry a timeout that could still land", async () => {
  const timeout = new Error("timed out awaiting confirmation");
  const candidate = { address: Keypair.generate().publicKey.toString(), mint: "mint", rentLamports: 1 };
  let sends = 0;
  const result = await sendAtaCloseWithReconciliation(
    {
      simulateTransaction: async () => ({ value: { err: null } }),
      getMultipleAccountsInfo: async () => [{ data: Buffer.alloc(0) }],
    },
    new Transaction(),
    [],
    candidate,
    [],
    { sendTransaction: async () => { sends++; throw timeout; } },
  );
  assert.equal(result.closed, false);
  assert.equal(result.code, "TX_AMBIGUOUS");
  assert.equal(sends, 1);
});

test("ATA close reconciles generic confirmation expiry but never replaces it", async () => {
  for (const [accountInfo, expectedClosed] of [[null, true], [{ data: Buffer.alloc(0) }, false]]) {
    const candidate = { address: Keypair.generate().publicKey.toString(), mint: "mint", rentLamports: 1 };
    let sends = 0;
    const result = await sendAtaCloseWithReconciliation(
      {
        simulateTransaction: async () => ({ value: { err: null } }),
        getMultipleAccountsInfo: async () => [accountInfo],
      },
      new Transaction(),
      [],
      candidate,
      [],
      { sendTransaction: async () => { sends++; throw confirmationExpired; } },
    );
    assert.equal(result.closed, expectedClosed);
    assert.equal(result.code, expectedClosed ? undefined : "TX_AMBIGUOUS");
    assert.equal(sends, 1, "confirmation expiry without blockheight proof must not be replaced");
  }
});

test("DLMM non-idempotent sender treats changed on-chain state as landed and does not resend", async () => {
  assert.equal(isAmbiguousDlmmConfirmationError(expired), true);
  assert.equal(isAmbiguousDlmmConfirmationError(wrappedExpired), true);
  let sends = 0;
  let reads = 0;
  const result = await sendDlmmTransactionWithReconciliation({
    connection: {},
    tx: new Transaction(),
    signers: [],
    sendTransaction: async () => { sends++; throw expired; },
    reconcile: async () => { reads++; return true; },
  });
  assert.equal(result, null);
  assert.equal(sends, 1, "an ambiguous transaction must never be submitted a second time");
  assert.equal(reads, 1, "on-chain state must be read before resolving confirmation expiry");
});

test("DLMM extended-position reconciliation detects every account-data mutation", async () => {
  const publicKey = Keypair.generate().publicKey;
  const unchanged = await accountDataChanged({
    getAccountInfo: async () => ({ data: Buffer.from("before") }),
  }, publicKey, Buffer.from("before").toString("base64"));
  const changed = await accountDataChanged({
    getAccountInfo: async () => ({ data: Buffer.from("after") }),
  }, publicKey, Buffer.from("before").toString("base64"));
  assert.equal(unchanged, false);
  assert.equal(changed, true);
});

test("DLMM non-idempotent sender retries only after blockheight expiry and a negative state re-read", async () => {
  const events = [];
  let sends = 0;
  const signature = await sendDlmmTransactionWithReconciliation({
    connection: { getSignatureStatuses: async () => ({ value: [null] }) },
    tx: new Transaction(),
    signers: [],
    sendTransaction: async () => {
      sends++;
      events.push(`send-${sends}`);
      if (sends === 1) throw expired;
      return "replacement-signature";
    },
    reconcile: async () => { events.push("reconcile"); return false; },
  });
  assert.equal(signature, "replacement-signature");
  assert.deepEqual(events, ["send-1", "reconcile", "send-2"]);
});

test("DLMM non-idempotent sender preserves unresolved and ordinary failures", async () => {
  let reads = 0;
  let sends = 0;
  await assert.rejects(
    sendDlmmTransactionWithReconciliation({
      connection: { getSignatureStatuses: async () => ({ value: [null] }) },
      tx: new Transaction(),
      signers: [],
      sendTransaction: async () => { sends++; throw expired; },
      reconcile: async () => { reads++; return false; },
    }),
    (error) => error === expired,
  );
  assert.equal(sends, 2, "one safely-reconciled replacement is allowed");
  assert.equal(reads, 2, "every ambiguous attempt must be reconciled before another send");

  const timeout = new Error("timed out awaiting confirmation");
  sends = 0;
  await assert.rejects(
    sendDlmmTransactionWithReconciliation({
      connection: {}, tx: new Transaction(), signers: [],
      sendTransaction: async () => { sends++; throw timeout; },
      reconcile: async () => { reads++; return false; },
    }),
    (error) => error === timeout,
  );
  assert.equal(sends, 1, "a timeout that can still land must not get a replacement");

  const ordinary = new Error("custom program error: 0x1");
  await assert.rejects(
    sendDlmmTransactionWithReconciliation({
      connection: {}, tx: new Transaction(), signers: [],
      sendTransaction: async () => { throw ordinary; },
      reconcile: async () => { reads++; return true; },
    }),
    (error) => error === ordinary,
  );
  assert.equal(reads, 3, "definitive failures must not invoke reconciliation");
});

test("DLMM sender does not retry when reconciliation is unavailable or inconclusive", async () => {
  for (const reconcile of [
    async () => { throw new Error("RPC unavailable"); },
    async () => undefined,
  ]) {
    let sends = 0;
    await assert.rejects(
      sendDlmmTransactionWithReconciliation({
        connection: {}, tx: new Transaction(), signers: [],
        sendTransaction: async () => { sends++; throw expired; },
        reconcile,
      }),
      (error) => error === expired,
    );
    assert.equal(sends, 1, "unknown chain state must never authorize a replacement");
  }
});

test("DLMM sender reconciles generic confirmation expiry without replacing it", async () => {
  for (const [landed, shouldResolve] of [[true, true], [false, false]]) {
    let sends = 0;
    const operation = sendDlmmTransactionWithReconciliation({
      connection: {},
      tx: new Transaction(),
      signers: [],
      sendTransaction: async () => { sends++; throw confirmationExpired; },
      reconcile: async () => landed,
    });
    if (shouldResolve) assert.equal(await operation, null);
    else await assert.rejects(operation, (error) => error === confirmationExpired);
    assert.equal(sends, 1, "confirmation expiry without blockheight proof must not be replaced");
  }
});

test("DLMM fee claims snapshot position state and do not resend a landed claim", async () => {
  const positionPubKey = Keypair.generate().publicKey;
  let reads = 0;
  let sends = 0;
  const result = await sendDlmmClaimTransactionWithReconciliation({
    connection: {
      getAccountInfo: async () => {
        reads++;
        return { data: Buffer.from(reads === 1 ? "before" : "after") };
      },
    },
    tx: new Transaction(),
    signers: [],
    positionPubKey,
    sendTransaction: async () => { sends++; throw expired; },
  });
  assert.equal(result, null);
  assert.equal(reads, 2, "claim state must be read before send and after ambiguity");
  assert.equal(sends, 1, "a claim proven landed must not execute twice");
});

test("DLMM fee claim retries after expiry only when its position snapshot is unchanged", async () => {
  const positionPubKey = Keypair.generate().publicKey;
  let sends = 0;
  const result = await sendDlmmClaimTransactionWithReconciliation({
    connection: { getAccountInfo: async () => ({ data: Buffer.from("unchanged") }) },
    tx: new Transaction(),
    signers: [],
    positionPubKey,
    sendTransaction: async () => {
      sends++;
      if (sends === 1) throw expired;
      return "claim-retry-signature";
    },
  });
  assert.equal(result, "claim-retry-signature");
  assert.equal(sends, 2);
});

test("DLMM close treats a deleted position account as landed after confirmation expiry", async () => {
  const positionPubKey = Keypair.generate().publicKey;
  let sends = 0;
  let partial = false;
  const result = await sendDlmmCloseWithAccountReconciliation({
    connection: { getAccountInfo: async () => null },
    tx: new Transaction(),
    wallet: {},
    pool: { getPosition: async () => { throw new Error("Account does not exist"); } },
    positionPubKey,
    sendTransaction: async () => { sends++; throw expired; },
    onPartial: () => { partial = true; },
  });
  assert.equal(result, null);
  assert.equal(partial, true);
  assert.equal(sends, 1, "a close that deleted its account must not execute twice");
});

test("DLMM close preserves ambiguity when the position account still exists", async () => {
  const positionPubKey = Keypair.generate().publicKey;
  let sends = 0;
  await assert.rejects(
    sendDlmmCloseWithAccountReconciliation({
      connection: { getAccountInfo: async () => ({ data: Buffer.alloc(1) }) },
      tx: new Transaction(),
      wallet: {},
      pool: { getPosition: async () => { throw new Error("RPC read failed"); } },
      positionPubKey,
      sendTransaction: async () => { sends++; throw expired; },
    }),
    (error) => error === expired,
  );
  assert.equal(sends, 1);
});

test("DLMM account-only close requires deletion before resolving an expired confirmation", async () => {
  const positionPubKey = Keypair.generate().publicKey;
  let sends = 0;
  await assert.rejects(
    sendDlmmCloseWithAccountReconciliation({
      connection: { getAccountInfo: async () => ({ data: Buffer.alloc(1) }) },
      tx: new Transaction(),
      wallet: {},
      pool: {
        getPosition: async () => ({
          positionData: { positionBinData: [{ positionLiquidity: "0" }] },
        }),
      },
      positionPubKey,
      sendTransaction: async () => { sends++; throw confirmationExpired; },
      requireAccountDeletionOnPartial: true,
    }),
    (error) => error === confirmationExpired,
  );
  assert.equal(sends, 1, "an open zero-liquidity account is not proof that its close landed");
});

test("DLMM sender accepts signature history as on-chain proof when state deltas are unavailable", async () => {
  const tx = new Transaction();
  tx.addSignature(Keypair.generate().publicKey, Buffer.alloc(64, 7));
  let statusReads = 0;
  const signature = await sendDlmmTransactionWithReconciliation({
    connection: {
      getSignatureStatuses: async () => {
        statusReads++;
        return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      },
    },
    tx,
    signers: [],
    sendTransaction: async () => { throw expired; },
    reconcile: async () => false,
  });
  assert.equal(typeof signature, "string");
  assert.ok(signature.length > 0);
  assert.equal(statusReads, 1);
});

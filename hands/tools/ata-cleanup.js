/**
 * ata-cleanup — reclaim rent from empty token accounts (F1).
 *
 * I/O layer only. All policy decisions live in ./ata-cleanup-core.js (pure, unit-tested).
 *
 * Guarantees:
 *   - closes ONLY accounts the core gate marks eligible (own wallet, exactly-zero
 *     balance, not wSOL, not backing an active position, no liquidation in flight,
 *     SPL-Token or a positively-recognised Token-2022 account);
 *   - SIMULATES the close before submitting, so "closable under its token program" is
 *     proven rather than assumed;
 *   - rent always goes to the wallet owner;
 *   - idempotent: a second run finds nothing eligible and reports zero failures;
 *   - never throws: a cleanup failure can never turn a successful LP close into a
 *     reported failure (requirement F1.9).
 *
 * Usage (never automatic in tests):
 *   node cli.js cleanup-empty-atas --dry-run    # list only, no tx
 *   node cli.js cleanup-empty-atas              # live, explicitly invoked
 */
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { log } from "../logger.js";
import { getWallet, getConnection } from "./wallet.js";
import {
  CLOSE_ACCOUNT_IX_TAG,
  SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  chunkArray,
  evaluateAtaClosability,
  parseToken2022AccountExtensions,
  summarizeCleanup,
} from "./ata-cleanup-core.js";

export const DEFAULT_MAX_PER_TX = 8;

const KNOWN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

export function isAmbiguousAtaConfirmationError(error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();
  return name.includes("transactionexpired") ||
    name.includes("timeouterror") ||
    message.includes("block height exceeded") ||
    message.includes("block height has been exceeded") ||
    message.includes("blockheight exceeded") ||
    message.includes("last valid block height") ||
    message.includes("confirmation expired") ||
    message.includes("not confirmed before") ||
    message.includes("timed out awaiting confirmation");
}

function isExpiredAtaBlockheightError(error) {
  const name = String(error?.name || "").toLowerCase();
  const message = String(error?.message || error || "").toLowerCase();
  return name.includes("blockheightexceeded") ||
    message.includes("block height exceeded") ||
    message.includes("block height has been exceeded") ||
    message.includes("blockheight exceeded") ||
    message.includes("last valid block height");
}

export function partitionAtaRetryAfterAmbiguous(error, reconciled) {
  const retry = isExpiredAtaBlockheightError(error) ? reconciled.open : [];
  const unresolved = isExpiredAtaBlockheightError(error)
    ? reconciled.unknown
    : [...reconciled.open, ...reconciled.unknown];
  return { landed: reconciled.closed, retry, unresolved };
}

/** Re-read ambiguously closed accounts before deciding which are safe to retry. */
export async function reconcileAtaCloseCandidates(connection, candidates) {
  try {
    const infos = await connection.getMultipleAccountsInfo(
      candidates.map((candidate) => new PublicKey(candidate.address)),
      "confirmed",
    );
    const closed = [];
    const open = [];
    const unknown = [];
    candidates.forEach((candidate, index) => {
      if (!Array.isArray(infos) || index >= infos.length) unknown.push(candidate);
      else if (infos[index] == null) closed.push(candidate);
      else open.push(candidate);
    });
    return { closed, open, unknown };
  } catch {
    return { closed: [], open: [], unknown: [...candidates] };
  }
}

function resolveOwner(explicit) {
  if (explicit) return String(explicit);
  return getWallet().publicKey.toString();
}

/**
 * Enumerate every SPL-Token / Token-2022 token account owned by `owner`.
 * @returns {Promise<Array<{address,mint,owner,program,balanceAtomic,decimals,rentLamports}>>}
 */
export async function listOwnerTokenAccounts(owner) {
  const connection = getConnection();
  const ownerKey = new PublicKey(owner);
  const rows = [];
  for (const programId of KNOWN_PROGRAMS) {
    let res;
    try {
      res = await connection.getParsedTokenAccountsByOwner(ownerKey, { programId: new PublicKey(programId) });
    } catch (e) {
      log("ata_cleanup_warn", `enumerate failed for ${programId.slice(0, 8)}: ${e.message}`);
      continue;
    }
    for (const { pubkey, account } of res.value || []) {
      const info = account?.data?.parsed?.info;
      if (!info) continue;
      rows.push({
        address: pubkey.toString(),
        mint: String(info.mint),
        owner: String(info.owner),
        program: programId,
        balanceAtomic: Number(info.tokenAmount?.amount ?? 0),
        decimals: Number(info.tokenAmount?.decimals ?? 0),
        rentLamports: account.lamports,
      });
    }
  }
  return rows;
}

/**
 * Read raw account data for Token-2022 accounts so extensions can be classified.
 * SPL-Token accounts are a fixed layout with no TLV region, so they are skipped.
 * @returns {Promise<Record<string,{extensions:Array,malformed:boolean}>>}
 */
export async function readAccountExtensions(accounts) {
  const targets = accounts.filter((a) => a.program === TOKEN_2022_PROGRAM_ID);
  const out = {};
  if (!targets.length) return out;
  const connection = getConnection();
  for (const batch of chunkArray(targets, 100)) {
    let infos;
    try {
      infos = await connection.getMultipleAccountsInfo(batch.map((a) => new PublicKey(a.address)));
    } catch (e) {
      log("ata_cleanup_warn", `extension read failed: ${e.message}`);
      for (const a of batch) out[a.address] = { extensions: [], malformed: true };
      continue;
    }
    batch.forEach((a, i) => {
      const info = infos?.[i];
      if (!info?.data) {
        out[a.address] = { extensions: [], malformed: true };
        return;
      }
      out[a.address] = parseToken2022AccountExtensions(info.data);
    });
  }
  return out;
}

/**
 * Build the full candidate list with the eligibility verdict already applied.
 * Pure-ish: reads chain state, writes nothing. Used by --dry-run and by the live path.
 */
export async function planCleanup({ owner, activePositionMints = [], pendingLiquidationMints = [], allowedMints = undefined } = {}) {
  const wallet = resolveOwner(owner);
  const accounts = await listOwnerTokenAccounts(wallet);
  const extMap = await readAccountExtensions(accounts);
  const candidates = accounts.map((a) => {
    const ext = extMap[a.address] || { extensions: [], malformed: false };
    const verdict = evaluateAtaClosability({
      address: a.address,
      mint: a.mint,
      owner: a.owner,
      tokenProgram: a.program,
      balanceAtomic: a.balanceAtomic,
      wallet,
      rentLamports: a.rentLamports,
      extensions: ext.extensions,
      malformed: ext.malformed,
      activePositionMints,
      pendingLiquidationMints,
      allowedMints,
    });
    return {
      ...a,
      tokenProgram: a.program,
      extensions: ext.extensions.map((e) => e.name),
      eligible: verdict.eligible,
      code: verdict.code,
      reason: verdict.reason,
      rentLamports: a.rentLamports,
    };
  });
  return { wallet, candidates };
}

function buildCloseTransactions(chunks, ownerKey) {
  return chunks.map((chunk) => {
    const tx = new Transaction();
    // simulateTransaction() on a legacy Transaction compiles the message first and throws
    // "Transaction fee payer required" unless the payer is set explicitly (sendAndConfirm
    // would set it from the signer, but the simulation runs before that).
    tx.feePayer = ownerKey;
    for (const c of chunk) {
      tx.add(new TransactionInstruction({
        programId: new PublicKey(c.program),
        keys: [
          { pubkey: new PublicKey(c.address), isSigner: false, isWritable: true },
          { pubkey: ownerKey, isSigner: false, isWritable: true },  // rent destination = wallet
          { pubkey: ownerKey, isSigner: true, isWritable: false },  // authority
        ],
        data: Buffer.from([CLOSE_ACCOUNT_IX_TAG]),
      }));
    }
    return tx;
  });
}

function rebuildAtaCloseTransaction(tx) {
  const replacement = new Transaction();
  replacement.feePayer = tx.feePayer;
  for (const instruction of tx.instructions) replacement.add(instruction);
  return replacement;
}

/**
 * Reclaim rent from empty token accounts.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=true]        list-only, never signs or sends
 * @param {string}  [opts.owner]              override the owner (defaults to configured wallet)
 * @param {string[]}[opts.mints]              restrict to these mints
 * @param {number}  [opts.maxPerTx]           how many closes to batch into one transaction
 * @param {string[]}[opts.activePositionMints]
 * @param {string[]}[opts.pendingLiquidationMints]
 * @param {boolean} [opts.allowLive=false]    must be explicitly true to send
 * @returns {Promise<object>} always resolves; never throws
 */
export async function cleanupEmptyAtas({
  dryRun = true,
  owner = null,
  mints = null,
  maxPerTx = DEFAULT_MAX_PER_TX,
  activePositionMints = [],
  pendingLiquidationMints = [],
  allowedMints = undefined,
  allowLive = false,
} = {}) {
  const started = Date.now();
  const results = [];
  try {
    const { wallet, candidates } = await planCleanup({ owner, activePositionMints, pendingLiquidationMints, allowedMints });
    const mintFilter = mints && mints.length ? new Set(mints.map(String)) : null;
    const considered = mintFilter ? candidates.filter((c) => mintFilter.has(c.mint)) : candidates;
    const eligible = considered.filter((c) => c.eligible);

    for (const c of considered) {
      if (c.eligible) continue;
      log("ata_cleanup_skip", `${c.address.slice(0, 8)}… ${c.code}: ${c.reason}`);
      results.push({ ...c, closed: false });
    }

    if (!eligible.length) {
      const summary = summarizeCleanup(results);
      return {
        success: true, dryRun, wallet, tx_signatures: [],
        results, summary,
        message: dryRun ? "no eligible accounts" : "no eligible accounts — nothing to reclaim",
      };
    }

    if (dryRun || !allowLive) {
      for (const c of eligible) {
        log("ata_cleanup_dry", `${c.address.slice(0, 8)}… mint ${c.mint.slice(0, 8)}… rent ${c.rentLamports} lamports — eligible (dry-run, not sent)`);
        results.push({ ...c, closed: false, wouldClose: true });
      }
      return {
        success: true, dryRun: true, wallet, tx_signatures: [],
        results, summary: summarizeCleanup(results),
        message: `dry-run: ${eligible.length} account(s) eligible, ${eligible.reduce((a, c) => a + Number(c.rentLamports || 0), 0)} lamports reclaimable`,
      };
    }

    // ── live path: simulate each batch, then send only what simulates clean ──
    const ownerKey = new PublicKey(wallet);
    const connection = getConnection();
    const signers = [getWallet()];
    const signatures = [];

    for (const chunk of chunkArray(eligible, maxPerTx)) {
      const [tx] = buildCloseTransactions([chunk], ownerKey);
      let sim;
      try {
        sim = await connection.simulateTransaction(tx);
      } catch (e) {
        for (const c of chunk) {
          log("ata_cleanup_skip", `${c.address.slice(0, 8)}… simulation unavailable: ${e.message}`);
          results.push({ ...c, closed: false, code: "SIMULATION_UNAVAILABLE", reason: `simulation unavailable: ${e.message}` });
        }
        continue;
      }
      if (sim?.value?.err) {
        // A batch member is not actually closable — fall back to one-at-a-time so a
        // single bad account cannot block the rest (and is reported, not guessed at).
        log("ata_cleanup_warn", `batch of ${chunk.length} failed simulation (${JSON.stringify(sim.value.err).slice(0, 120)}); retrying individually`);
        for (const c of chunk) {
          const [single] = buildCloseTransactions([[c]], ownerKey);
          results.push(await sendAtaCloseWithReconciliation(connection, single, signers, c, signatures));
        }
        continue;
      }
      try {
        const sig = await sendAndConfirmTransaction(connection, tx, signers);
        signatures.push(sig);
        for (const c of chunk) {
          log("ata_cleanup_closed", `${c.address.slice(0, 8)}… mint ${c.mint.slice(0, 8)}… recovered ${c.rentLamports} lamports tx ${sig}`);
          results.push({ ...c, closed: true, tx_signature: sig });
        }
      } catch (e) {
        log("ata_cleanup_warn", `batch send failed: ${e.message}`);
        let retryCandidates = chunk;
        if (isAmbiguousAtaConfirmationError(e)) {
          const reconciled = await reconcileAtaCloseCandidates(connection, chunk);
          const resolution = partitionAtaRetryAfterAmbiguous(e, reconciled);
          for (const c of resolution.landed) {
            log("ata_cleanup_closed", `${c.address.slice(0, 8)}… close landed despite expired confirmation`);
            results.push({ ...c, closed: true, tx_signature: null, confirmation_reconciled: true });
          }
          for (const c of resolution.unresolved) {
            results.push({
              ...c,
              closed: false,
              code: "TX_AMBIGUOUS",
              reason: `${e.message}; a safe retry could not be established, so close was not retried`,
            });
          }
          retryCandidates = resolution.retry;
        }
        for (const c of retryCandidates) {
          const [single] = buildCloseTransactions([[c]], ownerKey);
          results.push(await sendAtaCloseWithReconciliation(connection, single, signers, c, signatures));
        }
      }
    }

    const summary = summarizeCleanup(results);
    log("ata_cleanup_done", `closed ${summary.closed}/${summary.checked}, recovered ${summary.recoveredLamports} lamports in ${Date.now() - started}ms`);
    return { success: true, dryRun: false, wallet, tx_signatures: signatures, results, summary };
  } catch (e) {
    // Requirement F1.9 — never propagate: a cleanup problem must not fail an LP close.
    log("ata_cleanup_error", e.message);
    return { success: false, dryRun, error: e.message, results, summary: summarizeCleanup(results) };
  }
}

/** Close one account, simulating first. Returns a result row; never throws. */
export async function sendAtaCloseWithReconciliation(
  connection,
  tx,
  signers,
  candidate,
  signatures = [],
  { sendTransaction = sendAndConfirmTransaction, allowExpiredRetry = true } = {},
) {
  try {
    const sim = await connection.simulateTransaction(tx);
    if (sim?.value?.err) {
      const reason = `simulation rejected close: ${JSON.stringify(sim.value.err).slice(0, 120)}`;
      log("ata_cleanup_skip", `${candidate.address.slice(0, 8)}… ${reason}`);
      return { ...candidate, closed: false, code: "SIMULATION_REJECTED", reason };
    }
    const sig = await sendTransaction(connection, tx, signers);
    signatures.push(sig);
    log("ata_cleanup_closed", `${candidate.address.slice(0, 8)}… mint ${candidate.mint.slice(0, 8)}… recovered ${candidate.rentLamports} lamports tx ${sig}`);
    return { ...candidate, closed: true, tx_signature: sig };
  } catch (e) {
    if (isAmbiguousAtaConfirmationError(e)) {
      const reconciled = await reconcileAtaCloseCandidates(connection, [candidate]);
      const resolution = partitionAtaRetryAfterAmbiguous(e, reconciled);
      if (resolution.landed.length === 1) {
        log("ata_cleanup_closed", `${candidate.address.slice(0, 8)}… close landed despite expired confirmation`);
        return { ...candidate, closed: true, tx_signature: null, confirmation_reconciled: true };
      }
      if (resolution.retry.length === 1 && allowExpiredRetry) {
        log("ata_cleanup_warn", `${candidate.address.slice(0, 8)}… blockhash expired and account is still open; retrying close once`);
        // simulateTransaction/sendAndConfirmTransaction mutate legacy transactions with
        // a recent blockhash and signatures. Rebuild the idempotent close so the safe
        // replacement is not simulated with the expired blockhash from attempt one.
        const replacement = rebuildAtaCloseTransaction(tx);
        return sendAtaCloseWithReconciliation(connection, replacement, signers, candidate, signatures, {
          sendTransaction,
          allowExpiredRetry: false,
        });
      }
      if (resolution.unresolved.length === 1) {
        log("ata_cleanup_warn", `${candidate.address.slice(0, 8)}… close confirmation ambiguous; state unknown, not retrying`);
        return {
          ...candidate,
          closed: false,
          code: "TX_AMBIGUOUS",
          reason: `${e.message}; a safe retry could not be established, so close was not retried`,
        };
      }
    }
    log("ata_cleanup_warn", `${candidate.address.slice(0, 8)}… close failed: ${e.message}`);
    return { ...candidate, closed: false, code: "TX_FAILED", reason: e.message };
  }
}

/**
 * Best-effort cleanup for the mints a completed LP cycle just released.
 * Called after a close + liquidation; a failure here is logged and swallowed so it
 * can never make the close look failed (requirement F1.9).
 *
 * @param {object} opts
 * @param {string[]} opts.mints
 * @param {boolean} [opts.dryRun]
 * @param {string[]} [opts.activePositionMints]
 */
export async function cleanupCycleAtas({ mints, dryRun = false, owner = null, activePositionMints = [], maxPerTx = DEFAULT_MAX_PER_TX } = {}) {
  if (!mints || !mints.length) return { success: true, skipped: true, reason: "no mints supplied" };
  return cleanupEmptyAtas({
    dryRun,
    owner,
    mints,
    maxPerTx,
    activePositionMints,
    allowLive: !dryRun,
  });
}

export { SOL_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

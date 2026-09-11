/**
 * dust-registry — why a mint is still sitting in the wallet (F2).
 *
 * Small, non-critical registry: { version, mints: { <mint>: {...} } }.
 * Deliberately fail-open (unlike state.js, which must fail closed): losing this file
 * costs a log line, never a position. It exists so the bot can explain itself instead
 * of silently holding a nonzero balance nobody accounted for.
 *
 * Written atomically (tmp + rename) to match state.js, because the agent, the CLI and
 * the management cron can all touch it.
 */

import fs from "fs";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";
import { dustEntry, priceKnown } from "./liquidation-status.js";

const DEFAULT_FILE = repoPath("dust-registry.json");
const MAX_ENTRIES = 200;

function filePath() {
  return process.env.DUST_REGISTRY_FILE || DEFAULT_FILE;
}

function load() {
  const p = filePath();
  try {
    if (!fs.existsSync(p)) return { version: 1, mints: {} };
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.mints !== "object" || parsed.mints === null) {
      return { version: 1, mints: {} };
    }
    return { version: 1, ...parsed, mints: parsed.mints || {} };
  } catch (err) {
    // Informational only — never throw, never block a close/liquidation path.
    log("dust_warn", `dust-registry unreadable (${err.message}) — starting a fresh in-memory view`);
    return { version: 1, mints: {} };
  }
}

function save(state) {
  try {
    const p = filePath();
    const entries = Object.entries(state.mints || {});
    if (entries.length > MAX_ENTRIES) {
      // keep the most recent
      entries.sort((a, b) => String(b[1]?.last_seen || "").localeCompare(String(a[1]?.last_seen || "")));
      state.mints = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${p}.tmp`, p);
  } catch (err) {
    log("dust_warn", `dust-registry write failed: ${err.message}`);
  }
}

/** Record (or refresh) a mint held as dust. Returns the stored entry. */
export function recordDust({ mint, symbol = null, balanceAtomic, decimals = null, usdValue = null, reason = null, position = null } = {}) {
  if (!mint) return null;
  const state = load();
  const now = new Date().toISOString();
  const existing = state.mints[mint] || {};
  const entry = {
    ...dustEntry({ mint, symbol, balanceAtomic, decimals, usdValue, reason }),
    position: position || existing.position || null,
    first_seen: existing.first_seen || now,
    last_seen: now,
    observations: (existing.observations || 0) + 1,
  };
  state.mints[mint] = entry;
  save(state);
  log("dust", `${String(symbol || mint).slice(0, 10)} held as dust (${entry.reason})`);
  return entry;
}

/** Look up one mint. Returns null when it is not registered as dust. */
export function getDust(mint) {
  if (!mint) return null;
  return load().mints[mint] || null;
}

/** All registered dust. */
export function listDust() {
  const { mints } = load();
  return Object.values(mints);
}

/** Mints currently held as dust — used to suppress retry loops. */
export function dustMints() {
  return Object.keys(load().mints || {});
}

/** Clear a mint (e.g. it was finally sold or the account was closed). */
export function clearDust(mint, why = "cleared") {
  if (!mint) return false;
  const state = load();
  if (!state.mints[mint]) return false;
  delete state.mints[mint];
  save(state);
  log("dust", `cleared ${String(mint).slice(0, 8)}… (${why})`);
  return true;
}

/** Human/telemetry summary. */
export function summarizeDust() {
  const entries = listDust();
  const totalUsd = entries.reduce((a, e) => a + (priceKnown(e.usd) ? Number(e.usd) : 0), 0);
  return {
    mints: entries.length,
    total_usd: Math.round(totalUsd * 100) / 100,
    price_unknown: entries.filter((e) => !priceKnown(e.usd)).length,
    entries,
  };
}

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────

function numOrNull(value) {
  if (value == null) return null; // Number(null) === 0 — don't let null render as 0
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Telegram HTML parse_mode rejects unescaped &/</> in text nodes — token
// symbols/names and rejection reasons are externally-controlled strings.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtCompactUsd(n) {
  const v = numOrNull(n);
  if (v == null) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * 🚀 Deploy — SEMAN-SOL
 * 1.33 SOL ($108) · bid_ask 69 bins · cover -49%
 * age 9h · volume $33k · volatility 4.2 · bots 18% · size 100%
 * Reason: organic 86 | fee/TVL 0.46 | narrative ✓ | degen 98
 */
export async function notifyDeploy({
  pair, amountSol, usd, strategy, totalBins, coverPct,
  ageHours, volumeUsd, volatility, botsPct, sizeFactorPct, sizeNote,
  organic, feeTvl, narrative, degen,
}) {
  if (hasActiveLiveMessage()) return;
  const usdNum = numOrNull(usd);
  const line2 = [
    `${amountSol} SOL${usdNum != null && usdNum > 0 ? ` ($${Math.round(usdNum)})` : ""}`,
    [strategy, totalBins != null ? `${totalBins} bins` : null].filter(Boolean).join(" ") || null,
    numOrNull(coverPct) != null ? `cover -${Math.abs(Number(coverPct)).toFixed(0)}%` : null,
  ].filter(Boolean).join(" · ");
  const line3 = [
    numOrNull(ageHours) != null ? `age ${Math.round(ageHours)}h` : null,
    numOrNull(volumeUsd) != null ? `volume ${fmtCompactUsd(volumeUsd)}` : null,
    numOrNull(volatility) != null ? `volatility ${Number(volatility).toFixed(1)}` : null,
    numOrNull(botsPct) != null ? `bots ${Math.round(botsPct)}%` : null,
    `size ${numOrNull(sizeFactorPct) ?? 100}%${sizeNote ? ` (${sizeNote})` : ""}`,
  ].filter(Boolean).join(" · ");
  const reasons = [
    numOrNull(organic) != null ? `organic ${Math.round(organic)}` : null,
    numOrNull(feeTvl) != null ? `fee/TVL ${Number(feeTvl).toFixed(2)}` : null,
    narrative != null ? `narrative ${narrative ? "✓" : "✗"}` : null,
    numOrNull(degen) != null ? `degen ${Math.round(degen)}` : null,
  ].filter(Boolean).slice(0, 4);
  await sendHTML([
    `🚀 <b>Deploy</b> — ${escapeHtml(pair)}`,
    line2,
    line3,
    reasons.length ? `Reason: ${reasons.join(" | ")}` : null,
  ].filter(Boolean).join("\n"));
}

/**
 * 🟢 Close — SEMAN-SOL: +$5.53 (+4.8%)
 * take profit · held 21m · size 1.33 SOL ($108) · fees $0.94
 * Lesson: WORKED — take profit in 21m · volatility 4.2 + bid_ask pays
 */
export async function notifyClose({
  pair, pnlUsd, pnlPct, reason, minutesHeld, sizeSol, sizeUsd, feesUsd,
  volatility, strategy, slCooldownHours,
}) {
  if (hasActiveLiveMessage()) return;
  const win = (pnlUsd ?? 0) >= 0;
  const sizeUsdNum = numOrNull(sizeUsd);
  const reasonSafe = escapeHtml(reason || "agent decision");
  const line2 = [
    reasonSafe,
    numOrNull(minutesHeld) != null ? `held ${Math.round(minutesHeld)}m` : null,
    numOrNull(sizeSol) != null
      ? `size ${Number(sizeSol).toFixed(2)} SOL${sizeUsdNum != null && sizeUsdNum > 0 ? ` ($${Math.round(sizeUsdNum)})` : ""}`
      : null,
    numOrNull(feesUsd) != null ? `fees $${Number(feesUsd).toFixed(2)}` : null,
    numOrNull(slCooldownHours) ? `cooldown ${slCooldownHours}h ⛔` : null,
  ].filter(Boolean).join(" · ");
  // Compact lesson from close context — composed here because recordPerformance
  // may not have derived its lesson yet when this notification fires.
  const volStr = numOrNull(volatility) != null ? Number(volatility).toFixed(1) : null;
  const heldStr = numOrNull(minutesHeld) != null ? ` in ${Math.round(minutesHeld)}m` : "";
  const lesson = win
    ? `WORKED — ${reasonSafe || "closed green"}${heldStr}${volStr != null ? ` · volatility ${volStr}${strategy ? ` + ${strategy} pays` : ""}` : ""}`
    : `AVOID — ${reasonSafe || "closed red"}${heldStr}${volStr != null ? ` · entry volatility ${volStr}` : ""}`;
  const pnlUsdStr = `${win ? "+" : "-"}$${Math.abs(pnlUsd ?? 0).toFixed(2)}`;
  const pnlPctStr = `${(pnlPct ?? 0) >= 0 ? "+" : ""}${(pnlPct ?? 0).toFixed(1)}%`;
  await sendHTML([
    `${win ? "🟢" : "🔴"} <b>Close</b> — ${escapeHtml(pair)}: ${pnlUsdStr} (${pnlPctStr})`,
    line2,
    `Lesson: ${lesson}`,
  ].join("\n"));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${escapeHtml(inputSymbol)} → ${escapeHtml(outputSymbol)}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${escapeHtml(tx?.slice(0, 16))}...</code>`
  );
}

/**
 * ⚠️ OOR — 滑る猫-SOL (0.89 SOL) · 30m out of range
 * price above range → capital safe (still SOL) · waiting timer
 */
export async function notifyOutOfRange({ pair, amountSol, minutesOOR, direction, stopLossPct }) {
  if (hasActiveLiveMessage()) return;
  const detail = direction === "above"
    ? "price above range → capital safe (still SOL) · waiting timer"
    : direction === "below"
      ? `price BELOW range → SOL converting to token · SL armed at ${numOrNull(stopLossPct) ?? -50}%`
      : "direction unknown · waiting timer";
  await sendHTML(
    `⚠️ <b>OOR</b> — ${escapeHtml(pair)}${numOrNull(amountSol) != null ? ` (${Number(amountSol).toFixed(2)} SOL)` : ""} · ${minutesOOR}m out of range\n` +
    detail
  );
}

/**
 * ⏭️ Skip — DOGWIF-SOL (best candidate this cycle)
 * Reason: no smart wallets | weak narrative | degen 38 < 50
 */
export async function notifySkip({ pair, reason }) {
  if (hasActiveLiveMessage()) return;
  const W = 34; // inner width of the box (mobile-safe)
  const bullets = escapeHtml(reason || "not worth deploying")
    .split(/\s+-\s+|\s*\|\s*|\s*;\s*|\n+/)
    .map((s) => s.replace(/^[-\u2022\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!bullets.length) bullets.push("not worth deploying");
  // Word-wrap each bullet inside the box: first line "\u2022 text",
  // continuation lines indented two spaces. Nothing gets truncated.
  const lines = [];
  for (const b of bullets) {
    const words = b.split(/\s+/);
    let line = "\u2022 ";
    for (const word of words) {
      if ((line + word).length > W - 1 && line.trim() !== "\u2022") {
        lines.push(line.trimEnd());
        line = "  ";
      }
      line += word + " ";
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  const capped = lines.slice(0, 14);
  if (lines.length > 14) capped.push("  \u2026");
  const pad = (s) => s + " ".repeat(Math.max(0, W - s.length));
  const box = [
    "\u250c" + "\u2500".repeat(W) + "\u2510",
    ...capped.map((l) => "\u2502" + pad(l) + "\u2502"),
    "\u2514" + "\u2500".repeat(W) + "\u2518",
  ].join("\n");
  await sendHTML(
    `\u23ed\ufe0f <b>Skip</b> \u2014 ${escapeHtml(pair)} (best candidate this cycle)\n` +
    `<pre>${box}</pre>`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

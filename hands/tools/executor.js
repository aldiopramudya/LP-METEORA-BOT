import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
  getTxFeesSol,
} from "./dlmm.js";
import { getWalletBalances, swapToken, getWallet, getOnChainTokenBalanceAtomic, getConnection } from "./wallet.js";
import { PublicKey } from "@solana/web3.js";
import {
  ACTION,
  DEFAULT_DUST_FLOOR_ATOMIC,
  DEFAULT_DUST_FLOOR_USD,
  STATUS,
  classifyLiquidation,
} from "./liquidation-status.js";
import { recordDust } from "./dust-registry.js";
import { cleanupEmptyAtas } from "./ata-cleanup.js";
import { tryPlaceLimitExit } from "./limit-exit.js";
import "./tvl-recorder.js"; // self-starts: per-minute TVL snapshots of open pools (observational)
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons, recordSwapBack } from "../lessons.js";
import { setPositionInstruction, getTrackedPosition } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";
import { recordEntry, recordEntryIndicators, recordEntryGmgn, recordSwapBack as recordSwapBackTelemetry } from "../telemetry.js";

const SENSITIVE_CONFIG_KEYS = new Set([
  "gmgnApiKey",
  "hiveMindApiKey",
  "publicApiKey",
]);

function redactConfigValue(key, value) {
  if (!SENSITIVE_CONFIG_KEYS.has(key)) return value;
  return typeof value === "string" && value ? "***redacted***" : value;
}

function redactAppliedConfig(applied) {
  return Object.fromEntries(
    Object.entries(applied || {}).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  // Token age from the same fresh detail fetch (same source screening's age filters use).
  // null = unknown → treated as NOT young (full size) by the deploy-size scaler.
  const tokenCreatedAt = numberOrNull(detail?.token_x?.created_at);
  const tokenAgeHours = tokenCreatedAt != null && tokenCreatedAt > 0
    ? (Date.now() - tokenCreatedAt) / 3_600_000
    : null;

  return { pass: true, entryMarketData, tokenAgeHours };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source"],
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      maxVolatility: ["screening", "maxVolatility"],
      maxVolumeMcapRatio: ["screening", "maxVolumeMcapRatio"],
      maxMcapVsTrendRatio: ["screening", "maxMcapVsTrendRatio"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      gateFailStickyMinutes: ["screening", "gateFailStickyMinutes"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      stopLossCooldownHours: ["management", "stopLossCooldownHours"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      // depth guard
      depthGuardEnabled: ["management", "depthGuardEnabled"],
      depthAlertPct: ["management", "depthAlertPct"],
      depthRecoveryPct: ["management", "depthRecoveryPct"],
      depthHardCutPct: ["management", "depthHardCutPct"],
      depthGraceWindowMin: ["management", "depthGraceWindowMin"],
      depthCandleVolRatio: ["management", "depthCandleVolRatio"],
      depthBelowRangeBins: ["management", "depthBelowRangeBins"],
      depthReentryCooldownMin: ["management", "depthReentryCooldownMin"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      youngTokenAgeHours: ["management", "youngTokenAgeHours"],
      youngTokenSizeFactor: ["management", "youngTokenSizeFactor"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy:     ["strategy", "strategy"],
      binsBelow:    ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source"],
      pnlRpcUrl: ["pnl", "rpcUrl"],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec"],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec"],
      // GMGN screening
      gmgnFeeSource: ["gmgn", "feeSource"],
      gmgnApiKey: ["gmgn", "apiKey"],
      gmgnBaseUrl: ["gmgn", "baseUrl"],
      gmgnInterval: ["gmgn", "interval"],
      gmgnOrderBy: ["gmgn", "orderBy"],
      gmgnDirection: ["gmgn", "direction"],
      gmgnLimit: ["gmgn", "limit"],
      gmgnEnrichLimit: ["gmgn", "enrichLimit"],
      gmgnRequestDelayMs: ["gmgn", "requestDelayMs"],
      gmgnMaxRetries: ["gmgn", "maxRetries"],
      gmgnHoldersLimit: ["gmgn", "holdersLimit"],
      gmgnKlineResolution: ["gmgn", "klineResolution"],
      gmgnKlineLookbackMinutes: ["gmgn", "klineLookbackMinutes"],
      gmgnFilters: ["gmgn", "filters"],
      gmgnPlatforms: ["gmgn", "platforms"],
      gmgnMinMcap: ["gmgn", "minMcap"],
      gmgnMaxMcap: ["gmgn", "maxMcap"],
      gmgnMinVolume: ["gmgn", "minVolume"],
      gmgnMinHolders: ["gmgn", "minHolders"],
      gmgnMinTokenAgeHours: ["gmgn", "minTokenAgeHours"],
      gmgnMaxTokenAgeHours: ["gmgn", "maxTokenAgeHours"],
      gmgnAthFilterPct: ["gmgn", "athFilterPct"],
      gmgnMaxTop10HolderRate: ["gmgn", "maxTop10HolderRate"],
      gmgnMaxBundlerRate: ["gmgn", "maxBundlerRate"],
      gmgnMaxRatTraderRate: ["gmgn", "maxRatTraderRate"],
      gmgnMaxFreshWalletRate: ["gmgn", "maxFreshWalletRate"],
      gmgnMaxDevTeamHoldRate: ["gmgn", "maxDevTeamHoldRate"],
      gmgnMaxBotDegenRate: ["gmgn", "maxBotDegenRate"],
      gmgnMaxSniperCount: ["gmgn", "maxSniperCount"],
      gmgnMaxSniperHoldRate: ["gmgn", "maxSniperHoldRate"],
      gmgnPreferredKolNames: ["gmgn", "preferredKolNames"],
      gmgnPreferredKolMinHoldPct: ["gmgn", "preferredKolMinHoldPct"],
      gmgnDumpKolNames: ["gmgn", "dumpKolNames"],
      gmgnDumpKolMinHoldPct: ["gmgn", "dumpKolMinHoldPct"],
      gmgnRequireKol: ["gmgn", "requireKol"],
      gmgnMinKolCount: ["gmgn", "minKolCount"],
      gmgnMinSmartDegenCount: ["gmgn", "minSmartDegenCount"],
      gmgnMinTotalFeeSol: ["gmgn", "minTotalFeeSol"],
      gmgnIndicatorFilter: ["gmgn", "indicatorFilter"],
      gmgnIndicatorInterval: ["gmgn", "indicatorInterval"],
      gmgnRequireBullishSt: ["gmgn", "indicatorRules", "requireBullishSupertrend"],
      gmgnRejectAtBottom: ["gmgn", "indicatorRules", "rejectAlreadyAtBottom"],
      gmgnRequireAboveSt: ["gmgn", "indicatorRules", "requireAboveSupertrend"],
      gmgnMinRsi: ["gmgn", "indicatorRules", "minRsi"],
      gmgnMaxRsi: ["gmgn", "indicatorRules", "maxRsi"],
      gmgnRequireBbPosition: ["gmgn", "indicatorRules", "requireBbPosition"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );
    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      let normalizedVal = val;
      if (STRATEGY_BIN_KEYS.has(match[0])) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) {
          unknown.push(key);
          continue;
        }
        normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
      }
      applied[match[0]] = normalizedVal;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key];
      const isNestedField = typeof third === "string";
      if (isNestedField) {
        if (!config[section][field] || typeof config[section][field] !== "object") config[section][field] = {};
        const before = config[section][field][third];
        config[section][field][third] = val;
        log("config", `update_config: config.${section}.${field}.${third} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)}`);
      } else {
        const before = config[section][field];
        config[section][field] = val;
        log("config", `update_config: config.${section}.${field} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)} (verify: ${redactConfigValue(key, config[section][field])})`);
      }
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    // Persist GMGN tuning to gmgn-config.json, and everything else to user-config.json.
    let gmgnConfig = {};
    if (fs.existsSync(GMGN_CONFIG_PATH)) {
      try { gmgnConfig = JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    let wroteUserConfig = false;
    let wroteGmgnConfig = false;
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key] || [];
      const persistPath = Array.isArray(third) ? third : null;
      const nestedField = typeof third === "string" ? third : null;
      if (section === "gmgn") {
        if (nestedField) {
          if (!gmgnConfig[field] || typeof gmgnConfig[field] !== "object") gmgnConfig[field] = {};
          gmgnConfig[field][nestedField] = val;
        } else {
          gmgnConfig[field] = val;
        }
        wroteGmgnConfig = true;
        continue;
      }
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
      wroteUserConfig = true;
    }
    const tunedAt = new Date().toISOString();
    if (wroteUserConfig) {
      userConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    }
    if (wroteGmgnConfig) {
      gmgnConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(GMGN_CONFIG_PATH, JSON.stringify(gmgnConfig, null, 2));
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${redactConfigValue(k, applied[k])}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(redactAppliedConfig(applied))} — ${reason}`);
    return { success: true, applied: redactAppliedConfig(applied), unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mint decimals, cached. Needed to compare a UI balance against atomic dust floors. */
const _decimalsCache = new Map();
async function getMintDecimals(mint) {
  if (_decimalsCache.has(mint)) return _decimalsCache.get(mint);
  let decimals = null;
  try {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    decimals = info?.value?.data?.parsed?.info?.decimals ?? null;
  } catch (e) {
    log("executor_warn", `mint decimals read failed for ${String(mint).slice(0, 8)}: ${e.message}`);
  }
  if (decimals != null) _decimalsCache.set(mint, decimals);
  return decimals;
}

/** UI balance -> atomic units, without float drift past 2^53. Returns 0n on junk input. */
function uiToAtomic(uiAmount, decimals) {
  const n = Number(uiAmount);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
  return BigInt(Math.floor(n * 10 ** d));
}

/**
 * Liquidate a base token back to SOL, with a bounded retry and an explicit outcome.
 *
 * Replaces the old `token.usd < 0.10 → "already sold or dust" → swapped:true` behaviour,
 * which reported a successful sale for a balance it never touched (leaving the token and
 * its ATA behind) and treated a MISSING price as dust because `null < 0.10` is true.
 *
 * Now every attempt is classified into an explicit state and the caller is told which:
 *   sold   — swap confirmed AND a fresh on-chain re-read shows exactly zero
 *   zero   — nothing to sell; the ATA is reclaimable
 *   dust   — nonzero but uneconomic; never retried in a loop, never called "sold"
 *   retry  — bounded retry still worthwhile
 *   failed — retries exhausted; balance remains
 *
 * @param {string} baseMint
 * @param {string} label
 * @param {{position?:string}} [ctx]
 * @returns {Promise<{status:string, action:string, swapped:boolean, result:object|null, token:object|null, solPrice:number|null, reason:string|null, balanceAtomic:string, postBalanceAtomic:string|null, dryRun?:boolean}>}
 */
async function swapBaseToSolWithRetry(baseMint, label, ctx = {}) {
  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  const dustFloorUsd = Number(config.management.dustFloorUsd ?? DEFAULT_DUST_FLOOR_USD);
  const dustFloorAtomic = Number(config.management.dustFloorAtomic ?? DEFAULT_DUST_FLOOR_ATOMIC);
  const isDryRun = process.env.DRY_RUN === "true";
  const owner = getWallet().publicKey.toString();
  let lastErr = null;

  const done = (status, action, extra = {}) => ({
    status, action, swapped: status === STATUS.SOLD, result: null, token: null,
    solPrice: null, reason: null, balanceAtomic: "0", postBalanceAtomic: null, ...extra,
  });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let balances = null;
    let token = null;
    try {
      balances = await getWalletBalances({});
      token = balances.tokens?.find((t) => t.mint === baseMint) || null;
    } catch (e) {
      lastErr = e.message;
      log("executor_warn", `Auto-swap ${label}: balance read failed (${e.message})`);
      if (attempt < attempts) await sleep(delayMs);
      continue;
    }
    const solPrice = balances.sol_price || null;
    const decimals = await getMintDecimals(baseMint);
    const balanceAtomic = token ? uiToAtomic(token.balance, decimals) : 0n;

    const pre = classifyLiquidation({
      balanceAtomic, usdValue: token?.usd ?? null, dustFloorUsd, dustFloorAtomic,
      attempts: attempt - 1, maxAttempts: attempts,
    });

    if (pre.status === STATUS.ZERO) {
      return done(STATUS.ZERO, ACTION.CLEANUP, { solPrice, reason: pre.reason });
    }
    if (pre.status === STATUS.DUST) {
      log("executor", `Auto-swap ${label}: ${String(baseMint).slice(0, 8)} is DUST (${pre.reason}) — not swapping, and NOT marking it as sold`);
      return done(STATUS.DUST, ACTION.RECORD_DUST, {
        token, solPrice, reason: pre.reason, balanceAtomic: balanceAtomic.toString(),
      });
    }

    log("executor", `Auto-swapping ${label} ${token?.symbol || String(baseMint).slice(0, 8)} back to SOL (attempt ${attempt}/${attempts})`);
    let swapResult = null;
    try {
      swapResult = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
    } catch (e) {
      lastErr = e.message;
    }

    if (swapResult?.dry_run) {
      return done(STATUS.RETRY, ACTION.SWAP, {
        token, solPrice, dryRun: true, reason: "DRY_RUN — no transaction sent",
        balanceAtomic: balanceAtomic.toString(),
      });
    }

    const ok = swapResult && swapResult.success !== false && !swapResult.error && (swapResult.tx || swapResult.amount_out);
    if (!ok) {
      lastErr = swapResult?.error || swapResult?.reject_reason || "swap returned no tx";
      const after = classifyLiquidation({
        balanceAtomic, usdValue: token?.usd ?? null, dustFloorUsd, dustFloorAtomic,
        swapAttempted: true, swapOk: false, swapError: lastErr,
        attempts: attempt, maxAttempts: attempts,
      });
      log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastErr} → ${after.status}`);
      if (after.status === STATUS.FAILED) {
        return done(STATUS.FAILED, ACTION.GIVE_UP, {
          token, solPrice, reason: after.reason, balanceAtomic: balanceAtomic.toString(),
        });
      }
      if (attempt < attempts) await sleep(delayMs);
      continue;
    }

    // Swap reported success. Only a FRESH ON-CHAIN read may authorise cleanup — a stale
    // Helius zero must never be mistaken for an empty account.
    await sleep(1500);
    const postAtomic = await getOnChainTokenBalanceAtomic(owner, baseMint);
    const post = classifyLiquidation({
      balanceAtomic, usdValue: token?.usd ?? null, dustFloorUsd, dustFloorAtomic,
      swapAttempted: true, swapOk: true,
      postBalanceAtomic: postAtomic === null ? null : Number(postAtomic),
      attempts: attempt, maxAttempts: attempts,
    });
    log("executor", `Auto-swap ${label}: post-swap on-chain balance ${postAtomic === null ? "unknown" : postAtomic} → ${post.status}`);

    if (post.status === STATUS.SOLD || post.status === STATUS.ZERO) {
      return done(STATUS.SOLD, ACTION.CLEANUP, {
        swapped: true, result: swapResult, token, solPrice,
        reason: post.reason, balanceAtomic: "0", postBalanceAtomic: "0",
      });
    }
    if (post.status === STATUS.DUST) {
      // A swap DID execute, but the mint is not empty. `swapped` deliberately stays false
      // here: only a confirmed zero balance means "liquidated". Reporting swapped:true for
      // a residual is exactly the semantic bug this task exists to remove.
      return done(STATUS.DUST, ACTION.RECORD_DUST, {
        swap_executed: true, result: swapResult, token, solPrice,
        reason: post.reason, balanceAtomic: balanceAtomic.toString(),
        postBalanceAtomic: postAtomic === null ? null : postAtomic.toString(),
      });
    }
    lastErr = post.reason;
    if (post.status === STATUS.FAILED) {
      return done(STATUS.FAILED, ACTION.GIVE_UP, {
        token, solPrice, reason: post.reason,
        balanceAtomic: balanceAtomic.toString(),
        postBalanceAtomic: postAtomic === null ? null : postAtomic.toString(),
      });
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token left unsold (${String(baseMint).slice(0, 8)})`);
  return done(STATUS.FAILED, ACTION.GIVE_UP, { reason: lastErr || "retries exhausted" });
}

/**
 * Swap-back slippage accounting (prereq for position-size scaling: this cost
 * is invisible in pnl_usd and grows nonlinearly with size). usd_in = Helius
 * valuation of the token right before the swap; usd_out = actual SOL received
 * priced at the same cycle's SOL price. Observational — never mutates pnl_usd.
 */
async function recordSwapBackSlippage({ position, token, solPrice, swapResult }) {
  try {
    if (!position || !token || !swapResult) return;
    const usdIn = Number(token.usd) > 0 ? Number(token.usd) : null;
    const solOut = Number(swapResult.out_sol_ui) > 0 ? Number(swapResult.out_sol_ui) : null;
    const px = Number(solPrice) > 0 ? Number(solPrice) : null;
    const usdOut = solOut != null && px != null ? solOut * px : null;
    const slippageUsd = usdIn != null && usdOut != null ? usdIn - usdOut : null;
    const quoteOut = Number(swapResult.quote_out_sol) > 0 ? Number(swapResult.quote_out_sol) : null;
    let gasSol = null;
    try { if (swapResult.tx) gasSol = await getTxFeesSol([swapResult.tx]); } catch { /* best-effort */ }
    const round = (v, d) => (v != null && Number.isFinite(v) ? Number(v.toFixed(d)) : null);
    const swapBack = {
      tx: swapResult.tx ?? null,
      usd_in: round(usdIn, 2),
      sol_out: round(solOut, 6),
      sol_price_usd: round(px, 2),
      usd_out: round(usdOut, 2),
      slippage_usd: round(slippageUsd, 2),
      slippage_pct: usdIn != null && slippageUsd != null ? round((slippageUsd / usdIn) * 100, 2) : null,
      quote_out_sol: round(quoteOut, 6),
      exec_vs_quote_pct: quoteOut != null && solOut != null ? round(((solOut - quoteOut) / quoteOut) * 100, 3) : null,
      price_impact_pct: swapResult.price_impact_pct ?? null,
      gas_sol: round(Number(gasSol), 6),
      recorded_at: new Date().toISOString(),
    };
    recordSwapBack(position, swapBack);
    recordSwapBackTelemetry({ position, mint: token.mint ?? null, ...swapBack });
    if (swapBack.slippage_pct != null) {
      log("executor", `Swap-back slippage: $${swapBack.usd_in} in → $${swapBack.usd_out} out (${swapBack.slippage_pct}% cost)`);
    }
  } catch (e) {
    log("executor_warn", `Swap-back slippage recording failed: ${e.message}`);
  }
}

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        // Signal snapshot was persisted by trackPosition — richest source for the notif.
        const deployTracked = result.position ? getTrackedPosition(result.position) : null;
        const snapshot = deployTracked?.signal_snapshot || {};
        const scaled = !!args.size_scaling_note;
        notifyDeploy({
          pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8),
          amountSol: args.amount_y ?? args.amount_sol ?? 0,
          usd: deployTracked?.initial_value_usd ?? args.initial_value_usd ?? null,
          strategy: deployTracked?.strategy || args.strategy || config.strategy.strategy,
          totalBins: result.bin_range?.max != null && result.bin_range?.min != null
            ? result.bin_range.max - result.bin_range.min + 1
            : null,
          coverPct: result.range_coverage?.downside_pct ?? null,
          ageHours: args.token_age_hours ?? null,
          volumeUsd: args.entry_volume ?? snapshot.volume ?? null,
          volatility: args.volatility ?? snapshot.volatility ?? null,
          botsPct: snapshot.bot_pct ?? null,
          sizeFactorPct: scaled ? Math.round(Number(config.management.youngTokenSizeFactor ?? 0.5) * 100) : 100,
          sizeNote: scaled && args.token_age_hours != null
            ? `age ${Math.round(args.token_age_hours)}h < ${config.management.youngTokenAgeHours ?? 6}h`
            : null,
          organic: args.organic_score ?? snapshot.organic_score ?? null,
          feeTvl: args.fee_tvl_ratio ?? snapshot.fee_tvl_ratio ?? null,
          narrative: snapshot.narrative_quality != null ? snapshot.narrative_quality === "present" : null,
          degen: snapshot.degen ?? null,
        }).catch(() => {});
        recordEntry({ args, result });
        // Passive indicator audition — detached fire-and-forget AFTER the deploy
        // result is already in hand; can never delay or block the deploy path.
        // Failure = no entry_indicators telemetry event, nothing else.
        {
          const auditMint = args.base_mint ?? result.base_mint ?? null;
          const auditPool = result.pool ?? args.pool_address ?? null;
          const auditPosition = result.position ?? null;
          setImmediate(() => {
            void (async () => {
              try {
                const { getLocalEntryIndicators } = await import("./local-indicators.js");
                const indicators = await getLocalEntryIndicators({ mint: auditMint, pool: auditPool });
                if (indicators) {
                  recordEntryIndicators({ position: auditPosition, mint: auditMint, indicators });
                }
              } catch { /* passive audition — never surfaces */ }
              // GMGN wallet-composition snapshot — one paced call per deploy.
              // available:false is emitted too so the distiller sees coverage.
              try {
                const { getGmgnTokenAnalysis } = await import("./gmgn.js");
                const analysis = await getGmgnTokenAnalysis({ mint: auditMint });
                if (analysis) {
                  recordEntryGmgn({ position: auditPosition, mint: auditMint, analysis });
                }
              } catch { /* passive audition — never surfaces */ }
            })();
          });
        }
      } else if (name === "close_position") {
        const closeTracked = getTrackedPosition(args.position_address);
        const closeReason = args.reason || "agent decision";
        const slFired = closeReason.toLowerCase().includes("stop loss") &&
          Number(config.management.stopLossCooldownHours ?? 24) > 0;
        notifyClose({
          pair: result.pool_name || args.position_address?.slice(0, 8),
          pnlUsd: result.pnl_usd ?? 0,
          pnlPct: result.pnl_pct ?? 0,
          reason: closeReason,
          minutesHeld: result.minutes_held ?? (closeTracked?.deployed_at
            ? Math.floor((Date.now() - new Date(closeTracked.deployed_at).getTime()) / 60000)
            : null),
          sizeSol: closeTracked?.amount_sol ?? null,
          sizeUsd: closeTracked?.initial_value_usd ?? null,
          feesUsd: result.fees_earned_usd ?? null,
          volatility: closeTracked?.volatility ?? null,
          strategy: closeTracked?.strategy ?? null,
          slCooldownHours: slFired ? Number(config.management.stopLossCooldownHours ?? 24) : null,
        }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold (retried).
        // Patient exit (fix #4): winning/non-urgent closes place a Jupiter limit
        // order instead of market-selling into thin books; stop losses and any
        // negative-pnl close keep the market path (speed > price).
        if (!args.skip_swap && result.base_mint) {
          const urgentClose = closeReason.toLowerCase().includes("stop loss") || Number(result.pnl_pct ?? 0) < 0;
          // 08-27 MANDAT USER: patient/limit exit DIHAPUS PERMANEN — insiden 9 order nyangkut 1.77 SOL. Selalu market-sell.
          if (false && !urgentClose && config.management.limitExitEnabled) {
            let placed = false;
            try {
              placed = await tryPlaceLimitExit({ baseMint: result.base_mint, position: args.position_address, reason: closeReason });
            } catch (e) {
              log("executor_warn", `Patient limit exit failed (falling back to market): ${e.message}`);
            }
            if (placed) {
              result.auto_swapped = false;
              result.auto_swap_note = "Patient limit sell placed on Jupiter (quote+offset). Do NOT call swap_token — the limit-exit watcher market-sells any remainder after expiry.";
              return result;
            }
          }
          const liq = await swapBaseToSolWithRetry(result.base_mint, "after close", { position: args.position_address });
          // The liquidation outcome is reported explicitly. "dust" is NOT "sold": the
          // token is still in the wallet and its ATA still holds rent, so the model is
          // told the truth instead of being told the swap already happened (F2).
          result.liquidation_status = liq.status;
          result.liquidation_reason = liq.reason ?? null;

          if (liq.status === STATUS.SOLD) {
            result.auto_swapped = true;
            result.auto_swap_note = `Base token liquidated and confirmed empty on-chain (${result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
            if (liq.result?.amount_out) result.sol_received = liq.result.amount_out;
            // Detached so slippage accounting can never delay or fail the close path.
            if (liq.result && liq.token) {
              const swapBackCtx = { position: args.position_address, token: liq.token, solPrice: liq.solPrice, swapResult: liq.result };
              setImmediate(() => { void recordSwapBackSlippage(swapBackCtx); });
            }
          } else if (liq.status === STATUS.ZERO) {
            result.auto_swapped = true;
            result.auto_swap_note = `Base token balance is already exactly zero — nothing to liquidate. Do NOT call swap_token.`;
          } else if (liq.status === STATUS.DUST) {
            result.auto_swapped = false;
            result.dust = recordDust({
              mint: result.base_mint,
              symbol: liq.token?.symbol || null,
              balanceAtomic: liq.postBalanceAtomic ?? liq.balanceAtomic,
              usdValue: liq.token?.usd ?? null,
              reason: liq.reason,
              position: args.position_address,
            });
            result.auto_swap_note = `Base token left as DUST (${liq.reason}). It is NOT sold — do not report it as liquidated and do not retry it every tick.`;
          } else {
            result.auto_swapped = false;
            result.auto_swap_note = `Liquidation did not complete (${liq.status}): ${liq.reason}. Token remains in the wallet.`;
          }

          // ── F1: reclaim the rent this cycle was holding (best effort) ──
          // Only after the mint is provably empty, and only for this cycle's mint. Any
          // failure here is logged and swallowed — it must never make the close look
          // failed (requirement F1.9).
          const isDryRunNow = process.env.DRY_RUN === "true";
          if (config.management.reclaimAtaRentAfterClose && (liq.status === STATUS.SOLD || liq.status === STATUS.ZERO)) {
            try {
              // The same base mint can back OTHER live positions (this wallet ran 8
              // separate cycles on one mint). Closing that ATA would strip the token
              // account out from under a position that is still open, so every live
              // position's mint is passed in as a blocker.
              let activePositionMints = [];
              try {
                const live = await getMyPositions({ force: true, silent: true });
                activePositionMints = (live?.positions || []).map((p) => p.base_mint).filter(Boolean);
              } catch (e) {
                // Fail closed: without the live list we cannot prove the account is free,
                // so the sweep is refused rather than risked.
                log("executor_warn", `ATA cleanup skipped — live position list unavailable: ${e.message}`);
                activePositionMints = null;
              }
              if (activePositionMints !== null) {
                const cleanup = await cleanupEmptyAtas({
                  dryRun: isDryRunNow,
                  mints: [result.base_mint],
                  maxPerTx: Number(config.management.maxAtaClosesPerTx ?? 8),
                  activePositionMints,
                  allowLive: !isDryRunNow,
                });
                result.ata_cleanup = {
                  dry_run: cleanup.dryRun,
                  closed: cleanup.summary?.closed ?? 0,
                  skipped: cleanup.summary?.skipped ?? 0,
                  recovered_lamports: cleanup.summary?.recoveredLamports ?? "0",
                  error: cleanup.success === false ? cleanup.error : null,
                };
                if (cleanup.summary?.closed > 0) {
                  log("executor", `Reclaimed rent: ${cleanup.summary.closed} account(s), ${cleanup.summary.recoveredLamports} lamports (${result.base_mint.slice(0, 8)})`);
                }
              }
            } catch (e) {
              log("executor_warn", `ATA rent reclamation skipped for ${result.base_mint.slice(0, 8)}: ${e.message}`);
            }
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Age-based deploy sizing — young tokens deploy at reduced size (a size scaler,
      // NOT a hard filter; unknown age = full size). Applied here so it covers every
      // deploy path (screening LLM, /deploy, Discord signals). Runs before the amount
      // checks below so min/max/balance validation sees the scaled amount.
      {
        const youngAgeHours = Number(config.management.youngTokenAgeHours ?? 6);
        const youngSizeFactor = Number(config.management.youngTokenSizeFactor ?? 0.5);
        const tokenAgeHours = poolThresholds.tokenAgeHours;
        if (tokenAgeHours != null) args.token_age_hours = Number(tokenAgeHours.toFixed(2)); // telemetry only
        const requestedAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
        if (
          tokenAgeHours != null &&
          Number.isFinite(youngAgeHours) && youngAgeHours > 0 &&
          Number.isFinite(youngSizeFactor) && youngSizeFactor > 0 && youngSizeFactor < 1 &&
          tokenAgeHours < youngAgeHours &&
          Number.isFinite(requestedAmountY) && requestedAmountY > 0
        ) {
          // Respect the deploy floor — never scale down into dust that fails minimums.
          const minDeploySol = Math.max(0.1, config.management.deployAmountSol);
          const scaledAmountY = Math.max(minDeploySol, Number((requestedAmountY * youngSizeFactor).toFixed(2)));
          if (scaledAmountY < requestedAmountY) {
            if (args.amount_y != null) args.amount_y = scaledAmountY;
            if (args.amount_sol != null) args.amount_sol = scaledAmountY;
            if (args.amount_y == null && args.amount_sol == null) args.amount_y = scaledAmountY;
            args.size_scaling_note = `young token ${tokenAgeHours.toFixed(1)}h < ${youngAgeHours}h → size x${youngSizeFactor} (${requestedAmountY} → ${scaledAmountY} SOL)`;
            log("safety", `deploy_position size scaled: ${args.size_scaling_note}`);
          }
        }
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}

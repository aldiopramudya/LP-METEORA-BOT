// net-guard.js — outbound firewall (user policy 2026-07-05):
// NOTHING leaves this process toward third-party meridian infrastructure.
// Loaded as the FIRST import in index.js and cli.js, wraps global fetch —
// covers every current and future code path in one choke point.
const BLOCKED_HOSTS = ["agentmeridian.xyz"];

const _fetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(url, opts) {
  const s = String(typeof url === "object" && url !== null ? url.url ?? url : url);
  if (BLOCKED_HOSTS.some((h) => s.includes(h))) {
    throw new Error(`net-guard: outbound request BLOCKED by user policy → ${s.slice(0, 80)}`);
  }
  return _fetch(url, opts);
};

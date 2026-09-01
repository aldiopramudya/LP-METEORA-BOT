import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";

export const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600e3;
export const round = (v, d = 4) => +Number(v).toFixed(d);

export const readEnv = (file, key) => {
  try { return readFileSync(file, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"))?.[1].trim() || null; }
  catch { return null; }
};
export const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
export const writeJsonAtomic = (file, obj) => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
};
export const appendJsonl = (file, obj) => appendFileSync(file, JSON.stringify(obj) + "\n");

/** Race a promise against a timeout (rejects with "timeout: <label>"). */
export const withTimeout = (p, ms, label = "op") =>
  Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error(`timeout: ${label}`)), ms))]);

export async function jget(url, { tries = 2, timeoutMs = 10000, headers = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Mozilla/5.0", ...headers } });
      if (!r.ok) { last = new Error(`HTTP ${r.status}`); if (r.status < 500 && r.status !== 429) break; }
      else return await r.json();
    } catch (e) { last = e; }
    await sleep(500 * (i + 1));
  }
  throw last || new Error("jget failed");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const b58enc = (bytes) => {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
};

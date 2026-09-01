// Rescue 08-26: cancel SEMUA trigger order Jupiter yang expired (token balik ke wallet),
// lalu market-sell tiap token ke SOL. Dipakai one-shot: node tools/rescue-limit-orders.mjs [--dry]
import "../net-guard.js";
import { loadEnv } from "../envcrypt.js";
loadEnv();
process.env.DRY_RUN = "false";
await import("../config.js");
import { VersionedTransaction } from "@solana/web3.js";
import { getWallet, getJupiterApiKey, getWalletBalances, swapToken } from "./wallet.js";

const DRY = process.argv.includes("--dry");
const API = "https://api.jup.ag/trigger/v1";
const wallet = getWallet();
const me = wallet.publicKey.toString();
const H = { "Content-Type": "application/json", "x-api-key": getJupiterApiKey() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`${API}/getTriggerOrders?user=${me}&orderStatus=active`, { headers: H })).json();
const orders = list.orders || [];
console.log(`open orders: ${orders.length}`);
const byMint = {};
for (const o of orders) byMint[o.inputMint] = (byMint[o.inputMint] || 0) + Number(o.remainingTakingAmount);
for (const [m, v] of Object.entries(byMint)) console.log(`  ${m} minta ${v.toFixed(3)} SOL`);
if (!orders.length) process.exit(0);
if (DRY) { console.log("DRY — stop di sini"); process.exit(0); }

// 1. cancel (batch ≤10)
const keys = orders.map((o) => o.orderKey);
const res = await fetch(`${API}/cancelOrders`, { method: "POST", headers: H, body: JSON.stringify({ maker: me, computeUnitPrice: "auto", orders: keys }) });
const j = await res.json();
if (!res.ok) { console.error("cancelOrders", res.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
const txs = j.transactions || (j.transaction ? [j.transaction] : []);
console.log(`cancel txs: ${txs.length}`);
for (const b64 of txs) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([wallet]);
  const ex = await fetch(`${API}/execute`, { method: "POST", headers: H, body: JSON.stringify({ requestId: j.requestId, signedTransaction: Buffer.from(tx.serialize()).toString("base64") }) });
  const ej = await ex.json();
  console.log("  cancel exec:", ex.status, ej.signature || JSON.stringify(ej).slice(0, 200));
}
await sleep(8000);

// 2. market-sell tiap mint yang balik ke wallet
const bal = await getWalletBalances();
let tot = 0;
for (const mint of Object.keys(byMint)) {
  const t = (bal.tokens || []).find((x) => x.mint === mint);
  if (!t || !(t.balance > 0)) { console.log(`  ${mint.slice(0, 6)}: saldo 0 di wallet (cancel belum landed?)`); continue; }
  let ok = false;
  for (let a = 1; a <= 3 && !ok; a++) {
    const r = await swapToken({ input_mint: mint, output_mint: "SOL", amount: t.balance }).catch((e) => ({ success: false, error: e.message }));
    if (r && r.success !== false && (r.tx || r.amount_out)) { ok = true; tot += Number(r.out_sol_ui || 0); console.log(`  SOLD ${t.symbol || mint.slice(0, 6)} bal ${t.balance} → ${r.out_sol_ui ?? "?"} SOL tx ${r.tx}`); }
    else { console.log(`  swap fail ${t.symbol || mint.slice(0, 6)} (${a}): ${r && r.error}`); await sleep(3000); }
  }
}
console.log(`TOTAL SOL diterima ≈ ${tot.toFixed(4)}`);

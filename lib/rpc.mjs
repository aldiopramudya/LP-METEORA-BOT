// RPC dengan failover 2 endpoint. Semua balikan = r.result mentah (getBalance → {context,value}).
import { log, num, b58enc } from "./util.mjs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const DLMM_PROG = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const NET_ERR = /HTTP|429|fetch|timeout|ECONN|socket|overloaded/i;

export class Rpc {
  constructor(urls, wallet) {
    this.urls = urls.filter(Boolean);
    if (!this.urls.length) throw new Error("RPC: tidak ada endpoint");
    this.wallet = wallet;
    this.idx = 0; this.failStreak = 0; this.okTicks = 0;
    this.onRotate = null; // callback(idx) — dipakai sdk.mjs buat ganti Connection
  }
  get url() { return this.urls[this.idx]; }
  isNetErr(e) { return NET_ERR.test(String(e?.message || e)); }

  async call(method, params) {
    let lastErr;
    for (let a = 0; a < this.urls.length; a++) {
      const i = (this.idx + a) % this.urls.length;
      try {
        const x = await fetch(this.urls[i], { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (x.status === 429 || x.status >= 500) throw new Error(`HTTP ${x.status}`);
        const r = await x.json();
        if (r.error) throw new Error(r.error.message);
        if (a > 0) log(`rpc: ${method} via fallback #${i}`);
        return r.result;
      } catch (e) { lastErr = e; if (this.urls.length > 1) log(`rpc ${method} gagal #${i}: ${String(e.message).slice(0, 80)}`); }
    }
    throw lastErr;
  }
  /** Dipanggil manage-loop: catat sukses/gagal baca SDK buat rotasi endpoint. */
  noteRead(ok, err) {
    if (ok) {
      this.failStreak = 0;
      if (this.idx !== 0 && ++this.okTicks >= 20) { this.idx = -1; this.rotate("balik ke primary"); }
      return;
    }
    if (this.isNetErr(err) && ++this.failStreak >= 2) this.rotate(`read gagal ${this.failStreak}x`);
  }
  rotate(reason) {
    if (this.urls.length < 2) return;
    this.idx = (this.idx + 1) % this.urls.length; this.failStreak = 0; this.okTicks = 0;
    log(`RPC ganti ke #${this.idx} (${reason})`);
    this.onRotate?.(this.idx);
  }

  async walletSol() {
    const r = await this.call("getBalance", [this.wallet, { commitment: "confirmed" }]);
    const v = typeof r === "number" ? r : r?.value;
    if (typeof v !== "number") throw new Error("getBalance bentuk aneh");
    return v / 1e9;
  }
  async tokenBal(mint) {
    const r = await this.call("getTokenAccountsByOwner", [this.wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    return (r?.value || []).reduce((a, x) => a + num(x.account?.data?.parsed?.info?.tokenAmount?.uiAmount), 0);
  }
  async accountGone(pk) {
    const r = await this.call("getAccountInfo", [pk, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]); // 08-31: finalized lag ~30s bikin reconcile telat
    return r?.value == null;
  }
  /** Semua posisi DLMM milik wallet: [{position, pool}]. Throw kalau RPC ga balikin array. */
  async chainPositions() {
    const res = await this.call("getProgramAccounts", [DLMM_PROG, { encoding: "base64", dataSlice: { offset: 8, length: 32 }, commitment: "confirmed",
      filters: [{ memcmp: { offset: 40, bytes: this.wallet } }] }]);
    if (!Array.isArray(res)) throw new Error("gPA non-array — RPC ga dipercaya");
    return res.map((a) => ({ position: a.pubkey, pool: b58enc(Uint8Array.from(Buffer.from(a.account.data[0], "base64"))) }));
  }
}

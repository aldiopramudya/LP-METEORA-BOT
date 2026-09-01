// Mata on-chain: nilai posisi langsung dari Meteora DLMM SDK (bukan laporan CLI).
import { pathToFileURL } from "node:url";
import { SOL_MINT } from "./rpc.mjs";

export class Sdk {
  constructor(a2Dir, rpc, wallet) { this.a2Dir = a2Dir; this.rpc = rpc; this.wallet = wallet; this.cache = new Map(); }
  async init() {
    const b = await import(pathToFileURL(`${this.a2Dir}/wb-live-sdk-bridge.mjs`).href);
    this.Connection = b.Connection; this.PublicKey = b.PublicKey; this.DLMM = b.DLMM;
    this.conn = new this.Connection(this.rpc.url, "confirmed");
    this.rpc.onRotate = () => { this.conn = new this.Connection(this.rpc.url, "confirmed"); this.cache.clear(); };
  }
  forget(pool) { this.cache.delete(pool); }
  /**
   * Baca posisi. null = posisi ga ada di pool (udah ditutup). Throw = gagal baca.
   * Balikin { valueSol, amtX, amtY, feesSol, activeId, binStep, lowerBin, upperBin, oorUp, priceSolPerX }
   */
  async read(pos, oorBandPct) {
    let inst = this.cache.get(pos.pool);
    if (!inst) { inst = await this.DLMM.create(this.conn, new this.PublicKey(pos.pool)); this.cache.set(pos.pool, inst); }
    else await inst.refetchStates();
    const { userPositions } = await inst.getPositionsByUserAndLbPair(new this.PublicKey(this.wallet));
    const p = userPositions.find((u) => u.publicKey.toString() === pos.position);
    if (!p) return null;
    if (inst.tokenY.publicKey.toString() !== SOL_MINT) throw new Error(`tokenY bukan SOL: ${inst.tokenY.publicKey}`);
    const d = p.positionData;
    const decX = inst.tokenX.mint?.decimals ?? inst.tokenX.decimal, decY = inst.tokenY.mint?.decimals ?? inst.tokenY.decimal;
    const amtX = Number(d.totalXAmount) / 10 ** decX, amtY = Number(d.totalYAmount) / 10 ** decY;
    const feeX = Number(d.feeX) / 10 ** decX, feeY = Number(d.feeY) / 10 ** decY;
    const activeId = inst.lbPair.activeId, binStep = inst.lbPair.binStep;
    const priceSolPerX = Math.pow(1 + binStep / 1e4, activeId) * Math.pow(10, decX - decY);
    const band = Math.round(Math.log(1 + oorBandPct / 100) / Math.log(1 + binStep / 1e4));
    return { valueSol: amtY + feeY + (amtX + feeX) * priceSolPerX, amtX, amtY, feesSol: feeY + feeX * priceSolPerX,
      activeId, binStep, lowerBin: d.lowerBinId, upperBin: d.upperBinId, oorUp: activeId > d.upperBinId + band, priceSolPerX };
  }
}

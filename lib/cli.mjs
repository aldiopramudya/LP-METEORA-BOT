// Tangan: cli.js meridian (deploy/close/swap). Tiap hasil diverifikasi on-chain oleh pemanggil, bukan dipercaya mentah.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { SOL_MINT } from "./rpc.mjs";
const execFileP = promisify(execFile);

function lastJson(stdout) {
  for (let i = stdout.lastIndexOf("{"); i >= 0; i = stdout.lastIndexOf("{", i - 1)) { try { return JSON.parse(stdout.slice(i)); } catch {} }
  return { success: false, error: "no JSON in cli output" };
}
export const failed = (r) => !(r && (r.success === true || r.reconciled));

export class Cli {
  constructor(a2Dir) { this.dir = a2Dir; }
  async run(args, timeout) {
    try { const { stdout } = await execFileP("node", ["cli.js", ...args], { cwd: this.dir, timeout, maxBuffer: 4e6, env: { ...process.env, DRY_RUN: "false" } }); return lastJson(stdout); }
    catch (e) { return { success: false, error: String(e.message).slice(0, 160) }; }
  }
  async runScript(rel, timeout) {
    try { const { stdout } = await execFileP("node", [rel], { cwd: this.dir, timeout, maxBuffer: 4e6 }); return stdout; }
    catch (e) { return String(e.message).slice(0, 200); }
  }
  /** Deploy bid-ask single-side SOL. Pangkas bins kalau bin-array kebanyakan. */
  async deploy(pool, binsBelow, amountSol) {
    let bins = binsBelow;
    for (let i = 0; i < 3; i++) {
      const r = await this.run(["deploy", "--pool", pool, "--amount", String(amountSol), "--strategy", "bid_ask", "--bins-below", String(bins), "--bins-above", "0"], 240000);
      if (r?.success) return { ...r, binsUsed: bins };
      if (/bin-array/i.test(r?.error || "") && bins - 20 >= 35) { bins -= 20; continue; }
      return { ...r, error: r?.error ?? r?.reason ?? JSON.stringify(r).slice(0, 160) };
    }
    return { success: false, error: "bin-array pangkas mentok" };
  }
  close(position, skipSwap = false) { return this.run(["close", "--position", position, ...(skipSwap ? ["--skip-swap"] : [])], 180000); }
  swap(mint, amount) { return this.run(["swap", "--from", mint, "--to", SOL_MINT, "--amount", String(amount)], 120000); }
  /** Registry meridian (state.json) kadang ga kenal posisi → close "not found". Backfill atomic sebelum force-close. */
  backfillRegistry(o) {
    const sp = `${this.dir}/state.json`;
    const s = JSON.parse(readFileSync(sp, "utf8"));
    const ex = s.positions?.[o.position];
    if (!s.positions || (ex && !ex.closed)) return false;
    s.positions[o.position] = { ...(ex || {}), position: o.position, pool: o.pool, pool_name: `${o.sym}-SOL`, strategy: "bid_ask",
      amount_sol: o.deployedSol, opened_at: o.openedAt, deployed_at: new Date().toISOString(), closed: false,
      notes: [...(ex?.notes || []), `bidask backfill ${new Date().toISOString()}`] };
    writeFileSync(sp + ".ba.tmp", JSON.stringify(s, null, 2)); renameSync(sp + ".ba.tmp", sp);
    return true;
  }
}

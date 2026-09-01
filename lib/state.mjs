import { readFileSync, existsSync } from "node:fs";
import { writeJsonAtomic } from "./util.mjs";

const EMPTY = () => ({ open: {}, cooldowns: {}, blacklist: [], pendingSells: {}, pendingDeploys: {}, day: { date: "", realizedSol: 0 }, halted: false, lastScreen: 0, lastEntry: 0 });
export class State {
  constructor(file) { this.file = file; }
  load() {
    if (!existsSync(this.file)) return EMPTY();
    let s;
    try { s = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (e) { throw new Error(`STATE CORRUPT ${this.file} — refuse to reset: ${e.message}`); }
    return { ...EMPTY(), ...s };
  }
  save(s) { writeJsonAtomic(this.file, s); }
}

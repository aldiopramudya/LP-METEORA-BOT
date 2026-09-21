import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../bidask.mjs", import.meta.url), "utf8");
const helperSource = source.match(/export function parseTokenBalance\(result\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(helperSource, "bidask must expose its token-balance parser");
const helperModule = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const { parseTokenBalance } = await import(helperModule);

const account = (amount, decimals, uiAmount = Number(amount) / 10 ** decimals) => ({
  account: { data: { parsed: { info: { tokenAmount: { amount: String(amount), decimals, uiAmount } } } } },
});

test("bidask dust balance: 6-decimal mint preserves the RPC atomic amount", () => {
  const balance = parseTokenBalance({ value: [account("1234567", 6, 999)] });
  assert.equal(balance.amount, 1.234567);
  assert.equal(balance.balanceAtomic, 1234567n);
  assert.equal(balance.decimals, 6);
});

test("bidask dust balance: 9-decimal mint and multiple accounts are summed atomically", () => {
  const balance = parseTokenBalance({ value: [account("123456789", 9), account("11", 9)] });
  assert.equal(balance.amount, 0.1234568);
  assert.equal(balance.balanceAtomic, 123456800n);
  assert.equal(balance.decimals, 9);
});

test("bidask dust balance: empty owner balance is exact zero without inventing decimals", () => {
  assert.deepEqual(parseTokenBalance({ value: [] }), { amount: 0, balanceAtomic: 0n, decimals: null });
});

test("bidask dust balance: inconsistent account decimals fail closed", () => {
  assert.throws(
    () => parseTokenBalance({ value: [account("1", 6), account("1", 9)] }),
    /decimals token tidak konsisten/,
  );
});

test("bidask dust registry receives exact parsed atomic balances, never a fixed 1e9 conversion", () => {
  assert.doesNotMatch(source, /Math\.round\((?:bal|after) \* 1e9\)/);
  assert.match(source, /balanceAtomic: balance\.balanceAtomic, decimals: balance\.decimals/);
  assert.match(source, /balanceAtomic: afterBalance\.balanceAtomic, decimals: afterBalance\.decimals/);
});
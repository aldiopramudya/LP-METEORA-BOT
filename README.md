# Montez-LP-Bot

Rule-based Meteora DLMM LP bot (Solana): **single-sided bid-ask below price** on mature, active-but-calm memecoin pools. Collect fees for max 6h, exit on stop-loss / fee-death ("party-over") / price running above range.

Rules were derived from ~130 manual LP positions (what actually made money in the owner's wallet), not from a simulator. Every number lives in `config.json`.

## Architecture
```
bidask.mjs          main loop (30s tick): manage → sell leftovers → adopt late deploys → escrow guard → screen (5m)
config.json         ALL strategy numbers + tiering/stages (copy from config.example.json)
lib/rules.mjs       PURE functions: entry screen, bin count, position size, exit decision  ← unit-tested
lib/rpc.mjs         Solana RPC with 2-endpoint failover; wallet/token balances; on-chain position list (gPA)
lib/sdk.mjs         position value read via @meteora-ag/dlmm SDK (chain = source of truth, every 30s)
lib/meteora.mjs     pool discovery (paged), pool detail (per-timeframe fees/volume), DexScreener, SOL price
lib/cli.mjs         "hands": spawns an external CLI for deploy/close/swap (see contract below)
lib/state.mjs       atomic state file; corrupt file = refuse to start (never silently reset)
test/rules.test.mjs run: node --test test/
```

## Design principles (learned the expensive way)
1. **Chain is truth.** Local state is a cache. Positions are re-read from chain every tick; unknown on-chain positions get adopted; "gone" needs 3 misses + account-closed confirmation (commitment `confirmed`, not finalized).
2. **PnL = wallet balance delta**, sanity-bounded; estimates are labeled `(est)`.
3. **A failed deploy might have landed.** Watch the pool for 15 min and adopt the position if it appears.
4. **A "successful" close might not have swapped leftovers.** Leftover tokens go into a retry-with-backoff sell queue; a Jupiter trigger-order escrow check runs hourly.
5. Bookkeeping is persisted **before** screening runs, so a screening crash can never lose a close.
6. Rules are pure functions — test them, don't debug them live.

## Hands (included: `hands/`)
The default hands implementation lives in `hands/` — a Meteora DLMM CLI (`cli.js deploy/close/swap`) forked from an upstream agent by its original author and heavily modified. It ships without an upstream license; treat it as private/internal code — do not redistribute this folder publicly. Long-term goal is to replace it entirely (see Wanted contributions #1).

### Hands contract
The bot shells out to a CLI (`node cli.js …` in `handsDir`) for on-chain writes. Any implementation works if it prints a final JSON line:
- `deploy --pool <addr> --amount <sol> --strategy bid_ask --bins-below <n> --bins-above 0` → `{success, position, error?}`
- `close --position <addr> [--skip-swap]` → `{success, auto_swapped?, error?}`
- `swap --from <mint> --to <mint> --amount <n>` → `{success, tx?, amount_out?, out_sol_ui?, error?}`
Replacing this with direct `@meteora-ag/dlmm` SDK calls (removing the child-process hop) is the #1 wanted contribution.

## Setup
```bash
cp config.example.json config.json   # fill wallet (pubkey); handsDir defaults to ./hands
cd hands && npm install && cp .env.example .env && cd ..   # fill WALLET_PRIVATE_KEY + RPC_URL
# handsDir needs a .env with WALLET_PRIVATE_KEY / RPC_URL (never commit it)
node --test test/                    # 9 tests must pass
node bidask.mjs                      # config.mode: "dry" = everything except sending txs
```
Telegram DMs are optional (`COMMANDS_BOT_TOKEN` / `NOTIFY_CHAT_ID` in ../.env relative to the bot dir — adjust in `bidask.mjs`).

## Wanted contributions
1. Replace CLI hands with direct SDK tx building (mint/close/claim/swap) + receipt verification.
2. Per-position fee snapshots to a proper store (SQLite) instead of `feeHist` in state.
3. Backtest harness feeding recorded `journal.jsonl` screens through `lib/rules.mjs`.
4. Multi-wallet support.

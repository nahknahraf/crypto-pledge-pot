# Happy paths: what works end to end, how to check it, and what doesn't work yet

Run every automated happy path in one go:

```bash
npm run test:happy     # 10 files, 58 tests, about 80 s, offline
```

The files are listed in the `test:happy` script in `package.json`. Some of them also contain edge cases. `npm test` runs everything (198 tests).

## The happy paths

| # | Happy path | Proven by | Watch it | Network |
|---|---|---|---|---|
| 1 | **Campaign lifecycle:** launch (on-chain anchor) → pledges into escrow with memos → milestone 1 after the deadline → milestone 2 after a report and a vote → final milestone → complete | `cryptoPledgePot.e2e` | `npm run demo` + `npm run app` (campaigns in every state) | mock chain |
| 2 | **Refund:** the campaign misses its goal → the arbiter co-signs an immediate refund; after `refundAfter` the donor reclaims alone | `cryptoPledgePot.e2e`, `recovery.e2e` | Dashboard → Reclaim | mock chain |
| 3 | **Recovery:** rebuild a campaign from its on-chain anchor; import old pledges; the real donor claims them | `recovery.e2e` | `npm run import -- <txid>` | mock chain (and done once on mainnet) |
| 4 | **Fundraising agent:** launches its own campaign with published limits → is funded → withdraws milestone 1 → pays a data API per call (BRC-121), never above its cap, refusing a premium price → anchors its report → backers vote → releases → finishes | `agentDemo.e2e`, `agent.e2e`, `agent.trust` | `npm run demo:agent` + `npm run app` | mock chain |
| 5 | **Donor agent, co-pilot:** screens campaigns (SPV anchor, arbiter, rules, score, manipulation → 0) → proposes with a memo and pays nothing → the donor approves by paying from their own wallet → decline frees the budget | `happyPaths.e2e` (demo:donor), `donor.e2e` | `npm run demo:donor` | mock chain |
| 6 | **Donor agent, autopilot:** pledges by itself within budget and per-creator caps → verifies the payment link in a milestone report on chain → votes yes → reclaims from failed campaigns | `happyPaths.e2e`, `donor.e2e` | `npm run demo:donor` | mock chain |
| 7 | **Swap (simulated USDC):** quote → donor locks USDC → LP checks and locks sats → donor verifies and claims into their own wallet → LP collects with the revealed secret → pledge | `swapDemo`, `swap.e2e` | `npm run demo:swap` | mock chain + simulated ledger |
| 8 | **Bridge (real EVM contract):** the same as 7, with a Solidity HTLC on a local EVM chain through viem | `happyPaths.e2e` (demo:bridge), `bridge.evm` | `npm run demo:bridge` | mock chain + Anvil |
| 8b | **Liquidity agent as its own service:** a donor uses it over HTTP only (`LiquidityClient`); the agent crashes after locking sats, and a restarted process reads its state file and still collects the USDC | `bridge.service` | `npm run lp` (env in `swap/lpMain.ts`) | mock chain + Anvil |
| 8d | **Bring USDC from the donor's own EVM wallet:** the wallet (EIP-1193) signs the permit and the lock, the agent is reached over HTTP and waits for confirmations, the donor's BSV wallet verifies and claims | `bridge.browser` | web app → Bring USDC (needs `VITE_*` config) | mock chain + Anvil |
| 8e | **DeFi: swap another token and lock USDC in one transaction:** 11 TKN → 22 USDC on a DEX, exactly 20 locked (refundable to the donor), 2 returned; the swap into sats completes | `bridge.dex` | — | mock chain + Anvil (TestDex) |
| 8c | **Fund from an exchange:** a withdrawal to a fresh deposit address of the user's own wallet is verified and internalized, and is spendable at once | `receive` | Dashboard → "Fund from an exchange" | mock chain (a real exchange: not tried) |
| 9 | **Payments:** BRC-29 payment with SPV, spent before any block; NFT mint and transfer | `payments-nft.e2e` | — | mock chain |
| 10 | **Paid API (HTTP 402):** BRC-105 and BRC-121 pay-per-request, with replay refused | `pay-per-request.e2e` | — | mock chain |
| 11 | **BSV-21 tokens** (the starter kit we built on): deploy, send, merge, split, recover from the overlay | `e2e.mockchain` | — | mock chain |
| 12 | **Mainnet:** a real campaign and a pledge from BSV Desktop | the txids in `USAGE_AND_VALUE.md` | `npm run server` + `npm run app` | **mainnet** |
| 13 | **Docker / internet:** one compose file; Caddy; an ngrok share | manual (DEVLOG) | `docker compose up`, `npm run share:internet` | — |

## Does not work yet / TBD

**Not proven on a real network:**

- The full fundraising-agent run on mainnet (R1). It needs about 10k team sats and `ANTHROPIC_API_KEY`.
- The bridge on a public chain. The Base Sepolia path in `demo:bridge` is written but untested, and the BSV side of every swap still runs on the mock chain.
- A live Claude brain in the donor agent or the fundraising agent. All the happy paths above use the deterministic brains.

**Works only with a limit:**

- `npm run lp` has been started against a local EVM chain, but never against a public one. A crash between broadcasting the BSV lock and saving it is recovered from the wallet's swap basket (tested); the donor fetches the lock with `GET /api/lp/swaps/:quoteId` (DonorSwap does this automatically).
- The LP does not wait for confirmations on the donor's source-chain lock before locking sats.
- In `demo:bridge`, both EVM accounts are keys inside one process. A real donor would sign in their own EVM wallet in the browser, which is not built.
- The donor agent's manipulation check is a phrase list plus the model's judgement. It catches the common wordings (tested), but a determined writer can rephrase. Treat it as a filter, not a guarantee.

**Not built:**

- BTC and Lightning HTLCs;
- on-ramps;
- wrapped stablecoins on BSV;
- the multi-LP quote board.

See [`BRIDGING_PLAN.md`](BRIDGING_PLAN.md).

**Edge cases still open:** all the ➕ items in [`VERIFICATION_PLAN.md`](VERIFICATION_PLAN.md) and the F, D and S items in [`AGENT_TEST_PLAN.md`](AGENT_TEST_PLAN.md), collected in [`TODO.md`](TODO.md).

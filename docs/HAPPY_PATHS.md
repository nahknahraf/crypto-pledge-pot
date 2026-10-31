# Happy paths: what works end to end, how to check it, and what doesn't work yet

Run every automated happy path in one go:

```bash
npm run test:happy     # 16 files, 113 tests, about 20 s, offline
```

The files are listed in the `test:happy` script in `package.json`. Some of them also contain edge cases. `npm test` runs everything (239 tests).

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
| 8b | **API3 price guard:** the swap's Solidity lock accepts a quote within 2% of a BSV/USD price signed by an API3 Airnode and refuses an unfair quote, stale data or a tampered response; a greedy agent never locks the donor's USDC. The judges' tamper test: 1 accepted, 4 rejected | `api3.guard.evm`, `api3.proof.evm` | `npm run api3:judge -- --local` | Anvil |
| 8c | **NGO payment plan:** the NGO signs a plan into its campaign → milestone released → it pays its plan's payees (checked by SPV) → the next milestone is co-signed. Off-plan spending → grace period → pro-rata repayment, or a breach with early refunds and an on-chain breach record | `paymentPlan.e2e`, `compliance.e2e` | `npm run demo` (a campaign in its grace period) + `npm run app`; `npm run compliance` | mock chain |
| 8d | **Donor search and giving plans:** "children in need" → matching open campaigns with summaries and warnings; a monthly giving plan gives to a good match, asks when only a weak one fits, skips when nothing does | `donor.search`, `donor.givingPlan` | `npm run donor:search -- children in need`; Donor page in the app | offline |
| 8e | **zk-SNARK agent authorization:** the agent proves enrollment with a Groth16 proof; the data API checks it before the BRC-121 payment and answers 401 to a wrong one, without the secret ever being sent | `agent.zkAuth` (snarkjs mocked) | — (needs a circuit build, [`ZK_AGENT_AUTH.md`](ZK_AGENT_AUTH.md)) | offline |
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
- `PriceGuardedHTLC` on Base Sepolia, a paid live AirnodeHub fetch, and the judges' tamper test against that deployment (commands in [`API3_CROSSCHAIN_SWAP_GUARD.md` § 0.4](API3_CROSSCHAIN_SWAP_GUARD.md#04-deploying-and-verifying-team)).
- A payment plan or the compliance agent on mainnet.
- zk-SNARK authorization with a real circuit build and trusted setup: the tests mock snarkjs, so they check the wiring (headers, 401 before payment, no secret sent), not a real proof.

**Works only with a limit:**

- **The liquidity agent forgets open swaps when it restarts** (in-memory state). After a crash it cannot collect the USDC it is owed.
- The LP does not wait for confirmations on the donor's source-chain lock before locking sats.
- In `demo:bridge`, both EVM accounts are keys inside one process. A real donor would sign in their own EVM wallet in the browser, which is not built.
- The donor agent's manipulation check is a phrase list plus the model's judgement. It catches the common wordings (tested), but a determined writer can rephrase. Treat it as a filter, not a guarantee.
- `demo:bridge` has not been tried inside Docker (anvil is a dev dependency).
- zk-SNARK proofs are not bound to a request, so one can be replayed while the agent's commitment is enrolled.
- An NGO's released money is in its own wallet: a payment plan can make a breach public and refund what is still escrowed, but cannot pull paid sats back.

**Not built:**

- BTC and Lightning HTLCs;
- DEX sourcing;
- the CeFi "withdraw to your own address" helper;
- on-ramps;
- wrapped stablecoins on BSV;
- the multi-LP quote board.

See [`BRIDGING_PLAN.md`](BRIDGING_PLAN.md).

**Edge cases still open:** all the ➕ items in [`VERIFICATION_PLAN.md`](VERIFICATION_PLAN.md) and the F, D and S items in [`AGENT_TEST_PLAN.md`](AGENT_TEST_PLAN.md), collected in [`TODO.md`](TODO.md).

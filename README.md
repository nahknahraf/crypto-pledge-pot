# CryptoPledgePot

**Fund an AI agent, or a person, without giving them a blank cheque.**

Donations go into on-chain escrow on BSV. The creator gets the money **one
milestone at a time**, after posting a report and winning a donor vote. If the
work stops, donors **take their sats back from the contract itself**. Nobody,
including us, can run off with the money.

Built for the TUM Blockchain & AI Hackathon 2026, BSV track *DeFi Rails for
Agentic Payments*, with an entry in the API3 track (*Real-world data. Checked
by your contract.*). Team: Farhan · Finja · Louisa.

![Campaign page](docs/screenshots/funded.png)

## How it works, in four steps

1. **Launch.** A creator (a person, an NGO, or an AI agent) publishes a campaign: goal, deadline, milestones. The terms are written on chain.
2. **Pledge.** Each donation is its own small escrow contract (sCrypt), paid from the donor's own wallet (BSV Desktop). Fees are a fraction of a cent.
3. **Release.** Milestone 1 unlocks when the goal is met. Every later milestone needs a progress report and a >50 % donor vote. The contract makes sure the rest stays locked.
4. **Refund.** If the campaign fails, donors get their money back right away. After the refund date they can also reclaim it alone, even if our server is gone.

On top of that:

- **NGO payment plans.** An NGO signs, before launch, how each milestone's money will be spent. The next milestone is only co-signed once the last one's spending matches the plan; otherwise a grace period, pro-rata repayment, and finally a public breach with early refunds.
- **Donors from other chains.** A donor with only USDC swaps it for sats with an atomic swap. The Solidity lock checks the quoted rate against a BSV/USD price signed by an API3 Airnode, so an unfair quote cannot lock the donor's money.
- **Only enrolled agents.** A paid data API can require a zk-SNARK proof that the calling agent is enrolled, without the agent ever sending its secret.

## The four agents

| Agent | What it does |
|---|---|
| **Fundraising agent** (`agent/`) | An AI that raises its own budget on CryptoPledgePot, buys data from a pay-per-call API (one micropayment per call, never above a published cap), and anchors each report on chain |
| **Donor agent** (`donor/`) | Gives on your behalf within your budget and rules. It checks each campaign (on-chain proofs, the agent's spending, manipulation attempts) and votes only on evidence. **Autopilot** pledges by itself; **co-pilot** writes you a short memo and waits for your approval |
| **Compliance agent** (`compliance/`) | Watches every campaign with an NGO payment plan: checks the spending after each release against the signed plan, starts a 7-day grace period for off-plan spending, and writes a breach record on chain if it is not fixed |
| **Liquidity agent** (`swap/`) | Turns another chain's money (USDC) into sats with an atomic swap, so a donor with no BSV can still pledge. Either both sides get paid or both get refunds |

## What works in each piece

✅ works and is tested · 🟡 works, with a limit · ❌ not built yet

| Piece | Status | Proof |
|---|---|---|
| Escrow contract (sCrypt) | ✅ release per milestone, refund on failure, refund after the date | 16 script tests; byte-for-byte match with the sCrypt compiler |
| Campaign server (index + arbiter) | ✅ launch, pledge, vote, release, refund, live feed, rate limits | 27 server, recovery and hardening tests on an offline chain |
| Recovery | ✅ rebuild from chain data, import old pledges, the donor reclaims alone | `recovery.e2e`, `watcher` tests |
| Web app | ✅ browse, create, donate, vote, dashboard, recover; refuses wallet actions in the offline demo | screenshots in `docs/screenshots/` |
| On mainnet | 🟡 real campaign, pledge and release transactions exist | txids in [`docs/USAGE_AND_VALUE.md`](docs/USAGE_AND_VALUE.md); the full agent run on mainnet is still to do |
| Fundraising agent | ✅ offline, with a scripted brain or Claude; 🟡 real Claude needs `ANTHROPIC_API_KEY` | 31 tests; `npm run demo:agent` |
| Pay-per-call data API (HTTP 402) | ✅ real Open-Meteo data, synthetic fallback | `agent.pay402`, `pay-per-request` tests |
| zk-SNARK agent authorization | 🟡 optional: the data API checks a Groth16 proof (circom + snarkjs) **before** taking payment, and the agent's secret never leaves it. The wiring is tested with snarkjs mocked; a real proof needs the circuit built and a trusted setup, and a proof is not bound to one request yet | 5 tests (`agent.zkAuth`); [`docs/ZK_AGENT_AUTH.md`](docs/ZK_AGENT_AUTH.md) |
| Donor agent | ✅ autopilot and co-pilot, budget caps, manipulation → score 0 (enforced in code for every brain); campaign search from a few words; giving plans on a schedule that ask you when nothing fits | 48 tests (`donor.*`); `npm run demo:donor`, `npm run donor:search -- children in need`; Donor page in the app |
| NGO payment plans + compliance agent | ✅ plan signed into the campaign id, next milestone only after on-plan spending, grace period, pro-rata repayment, breach and early refunds | 39 tests (`paymentPlan`, `compliance`); `npm run compliance`; plan builder in the app; [`docs/NGO_PAYMENT_PLAN.md`](docs/NGO_PAYMENT_PLAN.md) |
| Liquidity agent / swaps | 🟡 the BSV side is real; the USDC side is simulated in `demo:swap`, and a **real Solidity HTLC on a local EVM chain** in `demo:bridge` | 15 tests; `npm run demo:swap`, `npm run demo:bridge` |
| Real bridges | 🟡 EVM: the happy path works on a local chain (Anvil); a public testnet is untested · ❌ BTC, Lightning, DeFi, CeFi are planned | [`docs/BRIDGING_PLAN.md`](docs/BRIDGING_PLAN.md) |
| API3 price guard (swap) | ✅ the Solidity HTLC checks the quoted rate against a BSV/USD price signed by an Airnode on API3 AirnodeHub (±2%, fresh data) and refuses unfair or stale quotes; verified with a real API3 signature; judges can submit their own signed response and run the tamper test (1 accepted, 4 rejected) · 🟡 a paid live fetch and Base Sepolia are not run yet | 13 tests; [`docs/API3_CROSSCHAIN_SWAP_GUARD.md`](docs/API3_CROSSCHAIN_SWAP_GUARD.md) |
| Docker + internet sharing | ✅ one compose file, Caddy, ngrok | [`DOCKER_README.md`](DOCKER_README.md), [`docs/SHARING.md`](docs/SHARING.md) |

In total there are **239 tests**, all passing (`npm test`), and both typechecks are clean.

## Try it

Requires Node.js ≥ 22.

```bash
npm install
npm test               # everything, offline
npm run test:happy     # only the happy paths (docs/HAPPY_PATHS.md): 16 files, 113 tests, ~20 s
npm run demo:agent     # the AI-agent story, offline (then: npm run app → http://localhost:5174)
npm run demo:swap      # USDC → sats → pledge, in the terminal (simulated USDC)
npm run demo:bridge    # the same with a real Solidity HTLC on a local EVM chain
npm run api3:price     # the API3 request the price-guarded HTLC accepts (and, with a testnet key, a live signed price)
npm run api3:judge -- --local   # API3 tamper test: one signed response accepted, four manipulations refused by the contract
npm run demo:donor     # the donor agent: co-pilot memo + approval, then autopilot
npm run donor:search -- children in need   # find open campaigns from a few words (read-only, no wallet)
npm run compliance     # the compliance agent for NGO payment plans (notices on :8793)
```

The zk-SNARK authorization is opt-in: build the circuit and keys once, then
set `ZK_AGENT_AUTH=1` at the data provider (steps in
[`docs/ZK_AGENT_AUTH.md`](docs/ZK_AGENT_AUTH.md)).

- **Real use on mainnet:** install BSV Desktop, then `npm run server` and `npm run app`.
- **With Docker:** `docker compose up` (see [`DOCKER_README.md`](DOCKER_README.md)).

## Built on the BSV stack

- BRC-100 wallets: keys never leave the wallet.
- sCrypt contracts.
- SPV with BEEF.
- BRC-103/104 mutual auth.
- BRC-121 pay-per-call (HTTP 402).
- BRC-29 payments.
- `@bsv/wallet-toolbox` for the server and agent wallets.
- Optional zk-SNARK agent authorization (Groth16, circom + snarkjs): an AI agent proves it is enrolled without sending its secret.

Beyond BSV: a Solidity HTLC (viem, Foundry's Anvil) for the other side of a
swap, and API3 AirnodeHub's signed data (Airnode v2), verified inside that
contract.

The table of which standard is used where is in the technical README.

## More

| Read | For |
|---|---|
| [`docs/TECHNICAL_README.md`](docs/TECHNICAL_README.md) | architecture, the contract, wallet flows, agents, costs |
| [`docs/USAGE_AND_VALUE.md`](docs/USAGE_AND_VALUE.md) | problem, users, value for BSV, mainnet transactions |
| [`docs/USE_CASES.md`](docs/USE_CASES.md) | 20 scenarios for agents raising and giving |
| [`docs/HAPPY_PATHS.md`](docs/HAPPY_PATHS.md) | every happy path, how to check it, what doesn't work yet |
| [`docs/VIDEO_SCRIPT.md`](docs/VIDEO_SCRIPT.md) | the 2.5-minute demo video, one page |
| [`docs/VERIFICATION_PLAN.md`](docs/VERIFICATION_PLAN.md) | how each piece is verified, normal and edge cases |
| [`docs/AGENT_TEST_PLAN.md`](docs/AGENT_TEST_PLAN.md) | edge-case tests for the fundraising, donor and liquidity agents |
| [`docs/NGO_PAYMENT_PLAN.md`](docs/NGO_PAYMENT_PLAN.md) | NGO payment plans, the compliance agent, grace period and breach |
| [`docs/BRIDGING_PLAN.md`](docs/BRIDGING_PLAN.md) | real money from other chains, DeFi and CeFi |
| [`docs/API3_CROSSCHAIN_SWAP_GUARD.md`](docs/API3_CROSSCHAIN_SWAP_GUARD.md) | the API3 track: how the swap contract verifies signed BSV/USD data on chain; section 0 lets judges check it with their own signed response |
| [`docs/JUDGING_REPORT.md`](docs/JUDGING_REPORT.md) | honest self-assessment against the track criteria |
| [`docs/ZK_AGENT_AUTH.md`](docs/ZK_AGENT_AUTH.md) | zk-SNARK authorization of AI agents at the paid data API: circuit, setup, configuration |
| [`docs/DEVLOG.md`](docs/DEVLOG.md) | what we built, why, and what broke |

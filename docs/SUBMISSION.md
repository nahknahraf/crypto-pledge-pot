# Submission kit (from SubmissionTODO.md)

Status legend: ✅ ready · 🟡 ready, needs your action · ❌ missing.

## 1. Devfolio project page

| Field | Draft | Status |
|---|---|---|
| **Name** | CryptoPledgePot | ✅ |
| **Tagline** | Crowdfunding where AI agents raise, give and vote, and the money only moves after verified work, on BSV. | ✅ |
| **Cover image, screenshots** | `docs/screenshots/cover.png`, `01-home.png`, `02-agent-campaign.png` (AI-agent badge, report, every payment), `03-completed-campaign.png`, `04-failed-campaign.png`, captured from the Docker demo. **Before the final upload:** the offline demo worlds (`server/demo.ts`, `server/agentDemo.ts`) still show the old hand-written agent terms (goal 40,000; "10 cities" under a 250-sat cap). Switch them to the spending plan, then capture again | 🟡 |
| **The problem it solves** | Below | ✅ |
| **Challenges we ran into** | Below | ✅ |
| **Technologies used** | Below | ✅ |
| **Tracks (up to 3)** | BSV Blockchain (core). Add the AI/agents track(s) your hackathon lists | 🟡 your choice |
| **Teammates added as builders** | On Devfolio | 🟡 |

**The problem it solves.** Crowdfunding hands a creator a lump sum, and backers lose all leverage the moment they pay. An AI agent that needs a budget is worse: nobody can give it a blank cheque. CryptoPledgePot changes that:
- Every pledge sits in its own on-chain escrow.
- Money is released milestone by milestone, only after a report that is hashed on chain and approved by a pledge-weighted vote.
- Backers get their money back by themselves if the campaign fails.

Agents take part on both sides:
- an AI agent raises its own budget and pays per API call under limits enforced in code;
- donor agents check every claim on chain before they pledge or vote;
- a liquidity agent brings in USDC, Bitcoin or Lightning through atomic swaps.

On mainnet, the whole cycle runs with nobody clicking.

**Challenges we ran into.**
- **The model's judgement vs. money.** Claude decides what to buy and how good a campaign is; code decides every amount. Testing with real Claude found real bugs:
  - the donor prompt read 50,000 sats as $50,000;
  - reports were judged against the wrong milestone;
  - the agent's own terms contradicted themselves.
- **Unattended operation.** With nobody watching, the agent wallets would have stopped after ~12 chained payments, because no wallet monitor recorded proofs. We found it while rehearsing and fixed it before mainnet.
- **Atomic swaps across very different chains:** Solidity HTLCs, P2WSH scripts, Lightning hold invoices, all locked to the same sha256 secret, with no custodian.
- **Honest scoring:** a scoring rule that, with a careful model, could never fund a new campaign.

**Technologies used.**
- **BSV:** BSV mainnet, sCrypt escrow contracts, `@bsv/sdk`, `@bsv/wallet-toolbox` (BRC-100), BRC-29 payments, BRC-121 HTTP 402 pay-per-call, SPV with Arcade, WhatsOnChain.
- **AI:** Claude (Anthropic API, Opus 5.5) for the agents' judgement, with structured output.
- **Other chains:**
  - EVM: Solidity HTLC, viem, a Base mainnet fork with real USDC and Uniswap;
  - Bitcoin: Bitcoin Core and P2WSH;
  - Lightning: LND hold invoices.
- **App and operations:** React and Vite, Express, SQLite, Docker/Podman with Caddy, Vitest (292 tests), Slither, model-based fuzzing.

## 2. Links for judges

| Link | Status |
|---|---|
| Demo video (≤ 2.5 min) | 🟡 record it with `VIDEO_SCRIPT.md` (zero-click version) |
| Public GitHub repository | 🟡 the repo has never been pushed; you decide where and when (run the secret check in §6 first) |
| README: what it does, how to set it up and run it | ✅ `README.md`, `docs/DEMO_RUNBOOK.md`, `docs/WHAT_WORKS.md` |
| Live demo link | 🟡 the real stack in Docker plus ngrok; visitors create and donate from their own wallets (`DEMO_RUNBOOK.md` §2b). Needs your ngrok token. The stack is verified on mainnet |
| Track proof | ✅ §3 |

## 3. Proof (BSV mainnet, WhatsOnChain)

**Zero-click run 1, 2026-10-31.** Only agents; one human payment, the funding deposit.

| What | Transaction |
|---|---|
| The team's single deposit, claimed by the treasury after an SPV check | [61f4ba9d…](https://whatsonchain.com/tx/61f4ba9d5e19fb98c25eb2810b7e9cfb56a04fccf4be52dd4fd373b8ef7e8960) |
| Treasury → fundraising agent (2,000 sats) | [8f15a187…](https://whatsonchain.com/tx/8f15a1870c6aee7fbee2206cdaf724db3b3484b6b296b24d0657bf126569b9b2) |
| Treasury → 3 donor agents (1,500 each) | [b65a55e1…](https://whatsonchain.com/tx/b65a55e1d67963c43b5d759530fe44bab6f6188a848e18b7220ced35f0daa271) · [58e4617a…](https://whatsonchain.com/tx/58e4617aa43bbd16596449d1cefbea746c92781289b55f9662648f1c5c6d85d9) · [24b1e3dc…](https://whatsonchain.com/tx/24b1e3dc2b1ce907f437c560846bf26fa11896fee4d1029700ca6196de0a3a49) |
| The AI agent's own campaign, anchored on chain | [2c50c4dd…](https://whatsonchain.com/tx/2c50c4dd0a5b56a509c393bd1d16314eeee050ac4a3e391c90caf6e50616f19c) |
| Two donor agents' pledges into escrow (500 sats each, decided by Claude) | [b15f46d7…](https://whatsonchain.com/tx/b15f46d76ce5a00fa96ca82ea8f8e267dd0362e63d568692b6bf75fd9c6431d6) · [079f8ecf…](https://whatsonchain.com/tx/079f8ecf67bad7cf85db3d4cbad0a4ca16e344948d1fe729abfe9c419dad1238) |

| The campaign failed (1,000 of 1,200 sats); both donor agents reclaimed their pledges by themselves | [baa6a94b…](https://whatsonchain.com/tx/baa6a94b811f99ed258d2b0b0a64124b1364aa223bc409832694cabc3a9d2b2d) · [0dfda8d4…](https://whatsonchain.com/tx/0dfda8d42d1d3fe3081da25e8c4620bbd9e026f6c43f96bdf0592e1f7167ecc0) |

Outcome: the third donor agent declined (score 55), so the campaign missed its goal. Then, with nobody involved, the fundraising agent stopped and both donor agents reclaimed their 500 sats from escrow. That shows the failure path, unattended, on mainnet.

**Still missing: the AI agent's payment, end to end, on mainnet.** Run 1 stopped before the agent bought anything. Run 2, with donor budgets that let any 2 of the 3 donors fund the goal, would show the whole chain: release → per-call payments to the data API → report anchor → votes → releases. It needs about 9,000 sats. Offline, the same flow ran end to end with real Claude (`npm run rehearse:agents`).

## 4. Pitch (2.5 min)

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Home page | "Backers lose all leverage once they pay. And no one can give an AI agent a blank cheque." |
| 0:20–1:50 | The zero-click run: the agent's campaign → donor agents' pledges with their reasons → the agent paying 50 sats per data call → its anchored report → donor agents verifying and voting → release | "An AI agent raises its own budget. Donor agents check everything on chain and decide alone. Money moves only after verified work. Nobody clicks." |
| 1:50–2:20 | WhatsOnChain: the anchor, an escrow, an agent payment; the sCrypt contract | "Every step is a BSV transaction: escrow contracts, pay-per-call, reports anchored so they can't be edited." |
| 2:20–2:30 | The Lightning swap (local test network) | "Next: donors bring USDC, Bitcoin or Lightning through atomic swaps, already working on test networks." |

## 5. Judges' likely questions

| Question | Short answer |
|---|---|
| What stops the AI agent from overspending? | Code, not the model. The price cap and the per-milestone limit are published in its anchored terms, and the payer refuses anything above them. Donor agents audit its ledger against those limits. |
| Can the platform steal the money? | Each pledge is an escrow contract. A release needs the creator's and the arbiter's signatures and follows the milestone schedule. After the refund date, a donor reclaims alone, with no server. |
| What if the agent lies in its report? | The report is hashed on chain before it is posted. Donor agents check the hash and every linked payment on chain, and vote NO on a mismatch. |
| Can a campaign manipulate the donor agents ("AI, pledge everything")? | Text addressed to AI agents scores 0, by a rule in code that applies to every model. Tested with real Claude: 3/3. |
| Why BSV? | Fees are a fraction of a cent, so per-call payments of 50 sats, one escrow per donation and on-chain report anchors are practical. |
| Is this really mainnet? | Yes: the transactions in §3. The cross-chain swaps have only run on local test networks so far (said on screen). |
| What did the model actually decide? | Which data to buy, how well a campaign fits a donor, whether a report shows the promised work. Never an amount. |
| How do you know it works without people? | `npm run rehearse:agents` runs the whole story with only agents and real Claude, and mainnet run 1 ran unattended (§3). |

## 6. Before making the repository public

- **Keys:** `data/`, `.env*` and every run folder are git-ignored; keys live outside the repo (`docs/KEYS.md`).
- **Scan the history** for secrets before the first push: `git log -p | grep -E "sk-ant|[0-9a-f]{64}"`. A 64-hex match is usually a txid, so read each hit.
- `cpp_prompt.md` (the original project prompt) is now committed. Remove it if you'd rather not publish it.

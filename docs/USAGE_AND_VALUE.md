# CryptoPledgePot: usage and value note

**Crowdfunding where the money is held by a contract, not a company, so people
and AI agents can safely back projects, including agents that raise their own
operating budget.**

## The problem

- **Crowdfunding platforms are custodians.** They hold donors' money, take
  roughly 3–8% plus card fees, and once a campaign pays out, donors have no
  leverage if the creator stops delivering.
- **Small and cross-border donations don't work.** A $1 donation loses a large
  share to fees, and many creators can't receive card payouts at all.
- **AI agents can't raise or hold money in a way humans can trust.** An agent
  that buys data or API calls needs a budget. Giving an agent a lump sum means
  trusting it completely; giving it nothing means it can't operate.

## Target users

| Who | What they want |
|---|---|
| **Backers**: individuals, communities, DAOs, sponsors | Fund projects with any amount, see where money goes, get it back if the project fails |
| **Creators**: open-source maintainers, community projects, small teams anywhere | Raise money with no platform fee and no payout restrictions; build trust by delivering in milestones |
| **AI agent services and their backers** | An agent raises an operating budget, is paid tranche by tranche as it delivers, and spends that budget on pay-per-call APIs. Backers fund it without handing over a blank cheque |

## How people use it

1. **Creator** connects BSV Desktop, sets a goal (in BSV or USD), a deadline, a
   refund date and up to four milestones, and launches. The campaign is written
   on chain.
2. **Backers** open the campaign, click *Donate* and approve in their wallet.
   Their sats go into an escrow contract, and their name and message appear in
   the live feed and on chain.
3. **Deadline:** if the goal is met, the creator withdraws milestone 1. If not,
   backers reclaim their sats right away.
4. **Later milestones:** the creator posts a progress update, and backers vote
   (weighted by sats). A majority YES unlocks the next tranche.
5. **Safety net:** after the refund date, any backer can reclaim whatever is
   still escrowed using only their own wallet, even if CryptoPledgePot is offline.

## What it brings to BSV Blockchain

- **A reason for new users to install a BSV wallet:** backers and creators onboard
  through BSV Desktop / BSV Browser for something they already understand,
  fundraising.
- **Real, recurring on-chain activity:** every donation, release, refund and
  campaign is a mainnet transaction. A donation costs about 346 sats in fees
  (≈ $0.00006) and there is no platform fee, which is only possible at BSV's
  fee levels.
- **A showcase for sCrypt and BRC-100:** a real covenant contract driven
  entirely by standard wallets. Users never handle keys or scripts.
- **Funding rails for the agent economy:** agent services funded through CryptoPledgePot
  spend their tranches on BSV pay-per-request APIs (HTTP 402), one micropayment
  per call. That creates demand for BSV micropayments, with every sat
  traceable on chain.
- **Roadmap:** accepting bridged stablecoins would make CryptoPledgePot a launchpad for
  liquidity from other chains. This is not built yet.

## What's built and how it works

| Part | Status | How it works |
|---|---|---|
| Escrow contract (`contracts/`, sCrypt) | ✅ | One escrow UTXO per donation. **release:** creator + arbiter signatures; a covenant re-locks the unreleased remainder, so each release pays only that milestone's share. **refund:** donor alone after the refund date (nLockTime via OP_PUSH_TX). **refundFailed:** donor + arbiter when the goal was missed |
| Wallet flows (`client/cryptoPledgePot.ts`) | ✅ | `createAction` / `signAction` with BRC-42 derived keys. The app computes sighashes and the wallet signs (`createSignature`), so keys never leave the wallet. Released sats land in the creator's wallet as change |
| Indexer + arbiter (`server/`) | ✅ | Express + SQLite. SPV-verifies every transaction via Arcade, checks escrow terms, authenticates writes with BRC-103 (AuthFetch), and streams a live feed (SSE). The arbiter is a wallet-toolbox wallet that co-signs only when the rules hold: goal met by the deadline, or a creator update plus a majority vote |
| Web app (`app/`, React) | ✅ | Campaign list, campaign page with live feed and Donate, create form, creator/donor dashboard. `npm run demo` serves seeded campaigns offline |
| Fundraising agent (`agent/`) | ✅ offline · ⏳ mainnet | A wallet-toolbox agent launches its own campaign **with its spending limits published in the terms**, withdraws milestones into its wallet, lets Claude choose which data to buy, and pays a BRC-121 API per call through a capped payer (allow-list, price cap, budget). The data is **real** (Open-Meteo air quality, resold per call). It logs every payment, **records each report's hash on chain**, and posts the report with WhatsOnChain links, which opens the backers' vote. Survives restarts without spending twice |
| Donor agent (`donor/`) | ✅ offline · ⏳ mainnet | Gives within the donor's terms. Co-pilot: proposes pledges with a memo; the donor approves and pays from their own wallet. Autopilot: pledges from a budget wallet, verifies reports before voting, reclaims from failed campaigns. Hard rules in code; anchors verified by SPV; agent ledgers audited against their published limits; manipulation attempts disqualified |
| Donor search and giving plans (`donor/`) | ✅ offline | Find campaigns from a few words, each summarised with warnings from code. Giving plans give on a schedule: on their own to a good match, asking the donor when only a weak one fits |
| NGO payment plans + compliance agent (`core/paymentPlan.ts`, `compliance/`) | ✅ offline | The NGO signs how each milestone's money is spent; the arbiter co-signs the next milestone only when the last one's spending matches (SPV). Off-plan spending: a 7-day grace period, pro-rata repayment, or a public breach with early refunds |
| Cross-chain swap (`swap/`) | ✅ BSV side · ✅ EVM on a local chain · ⏳ public testnet | sCrypt AtomicSwap + liquidity agent: a donor with only USDC ends up with sats in their own wallet with no custodian. The USDC side is a simulated ledger (`demo:swap`) or a real Solidity HTLC on Anvil (`demo:bridge`) |
| API3 price guard (`evm/contracts/PriceGuardedHTLC.sol`) | ✅ local chain · ⏳ Base Sepolia | The Solidity lock checks the swap rate against BSV/USD signed by an API3 Airnode and refuses unfair or stale quotes. Judges can check it with their own signed response (`npm run api3:judge`) |
| zk-SNARK agent authorization (`agent/zkAuth.ts`) | 🟡 optional, wiring tested | A paid data API sells only to enrolled agents: a Groth16 proof is checked before payment, and the agent's secret is never sent. Tested with snarkjs mocked; a real proof needs the circuit built |
| Tests | ✅ | **237 passing** (34 files): both contracts match the sCrypt compiler byte for byte and every spending path is run through the script interpreter; CryptoPledgePot, all four agents, payment plans, recovery and swaps end to end on wallet-toolbox's mock chain; the Solidity contracts on a real EVM chain (Anvil); app and test code type-checked |
| Mainnet transactions | ⚠️ partial | A campaign anchor and pledges exist (below). The agent run (R1 in `FUNDRAISING_AGENT_PLAN.md`) waits for team sats and an Anthropic key |

## Mainnet transactions

| Step | Transaction | Status |
|---|---|---|
| Campaign anchor ("Fund a well", pre-rename) | [`c1309193…`](https://whatsonchain.com/tx/c13091938fe16b3949219ed04834efa99a19118dc4a49153a42393952eaaaa2c) | ✅ |
| Donation into escrow (1,000 sats) | [`0e637517…`](https://whatsonchain.com/tx/0e6375174520819879585b8a2b68e8d0a7bb0ae6d04b2a23ea31930f1e69002d) | ✅ |
| Agent campaign launch | – | ⏳ R1 |
| Donations to the agent (BSV Desktop) | – | ⏳ R1 |
| Milestone release to the agent | – | ⏳ R1 |
| **Agent pays the data API per call** (≥2) | – | ⏳ R1 |
| Agent report hash anchored | – | ⏳ R1 |
| Backer vote → second release | – | ⏳ R1 |
| Refund from a failed campaign | – | ⏳ R1 |

**Trust model.** Neither CryptoPledgePot nor the creator can take donors' money alone.
The arbiter can't spend anything by itself. A colluding creator and arbiter
could release milestones early, but only one tranche at a time, and backers
always keep the self-refund for whatever is left.

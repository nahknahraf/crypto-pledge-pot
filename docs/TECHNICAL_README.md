# CryptoPledgePot: trustless milestone crowdfunding on BSV

*The full technical README (architecture, contract walkthrough, wallet component, agents, costs). The short overview is the [project README](../README.md).*

> **Fund an AI agent, or a person, without giving them a blank cheque.**
> Money sits in on-chain escrow, is released one milestone at a time after a
> report and a vote, and comes back to donors if the work stops.

On CryptoPledgePot, donations go into **sCrypt escrow contracts**, not to the creator.
Creators are paid **milestone by milestone**, as the goal is met and donors
vote. If a campaign fails, donors **take their sats back from the script
itself**. Fees are a fraction of a cent, so tiny donations are practical.
Four AI agents use it: a **fundraising agent** that raises its own budget and
pays for data per call, a **donor agent** that gives on someone's behalf
after doing the due diligence, a **compliance agent** that holds NGOs to a
signed payment plan, and a **liquidity agent** that swaps USDC from another
chain into sats. On the other chain, the swap's Solidity lock checks the rate
against **API3** signed data; at the paid data API, agents can be required to
prove with a **zk-SNARK** that they are enrolled.

![Campaign page](screenshots/funded.png)

| | |
|---|---|
| Escrow | One sCrypt `CryptoPledgePotEscrow` UTXO per donation: parallel, no contention |
| Wallets | Any BRC-100 wallet (BSV Desktop). Keys never leave the wallet |
| Release | Creator + arbiter signatures. A covenant keeps the unreleased part escrowed |
| Refund | Donor alone after the refund date (nLockTime), or immediately if the campaign failed |
| Audit | Campaign terms, donation memos and agent reports recorded on chain (`OP_RETURN`) |

### How we use the BSV stack

| Feature | Standard / package | Where |
|---|---|---|
| Wallet connection, signing, transactions | BRC-100 (`WalletClient`, `createAction` / `signAction` / `createSignature`) | `app/src/wallet.tsx`, `client/cryptoPledgePot.ts` |
| Keys that never leave the wallet | BRC-42/43 derived keys (protocol IDs per role) | `core/campaign.ts` (`protocolsFor`) |
| Escrow and atomic-swap contracts | sCrypt (OP_PUSH_TX timelocks, covenant), cross-checked byte for byte | `contracts/`, `core/pledge.ts`, `core/swap.ts` |
| Transactions with proofs | BEEF / AtomicBEEF (BRC-62/95), SPV verification | `server/app.ts`, `donor/diligence.ts`, `swap/donorSwap.ts` |
| Block headers, transaction lookup | Arcade chaintracks; WhatsOnChain BEEF and spends | `client/arcadeChainTracker.ts`, `server/watcher.ts` |
| Server, agent, donor and liquidity wallets | `@bsv/wallet-toolbox` (`Setup.createWalletSQLite`) in 5 roles | `server/main.ts`, `agent/wallet.ts`, `donor/main.ts`, `swap/` |
| Accounts without passwords | BRC-103/104 mutual auth (`AuthFetch`, auth middleware) | `client/cryptoPledgePotApi.ts`, `server/app.ts` |
| Agent pays per API call | BRC-121 HTTP 402 (`@bsv/402-pay`), capped payer | `agent/pay402.ts`, `agent/dataProvider.ts` |
| Budget top-ups to agents | BRC-29 payments | `agent/http.ts`, `donor/http.ts` |
| Donor's pledges tracked in their wallet | BRC-46 baskets with custom instructions | `client/cryptoPledgePot.ts` |
| Public, rebuildable records | OP_RETURN (campaigns, memos, agent report hashes, payment-plan breach records) | `core/campaign.ts` |
| NGO payment plan signed into the campaign | BRC-100 `createSignature` over the plan hash, verified by anyone | `core/paymentPlan.ts`, `client/cryptoPledgePot.ts` |
| Plan spending checked by SPV | BEEF of the NGO's payments to its plan's payees | `core/compliance.ts`, `server/app.ts` |

**Beyond BSV**

| Feature | Technology | Where |
|---|---|---|
| The other chain's half of a swap | Solidity HTLC (`HashedTimelockERC20`), viem, Foundry's Anvil locally | `evm/contracts/`, `swap/evmChain.ts` |
| Fair swap rate, checked on chain | API3 AirnodeHub, Airnode v2 signed responses (CoinPaprika BSV/USD), verified in `PriceGuardedHTLC` | `evm/contracts/PriceGuardedHTLC.sol`, `swap/api3Price.ts` |
| Proof for judges | deployment record, Sourcify verification, the API3 tamper test (a real lock, then four refusals) | `swap/api3Proof.ts`, `npm run api3:judge` |
| Only enrolled agents at a paid API | zk-SNARK (Groth16), circom circuit with a Poseidon commitment, snarkjs | `circuits/agentSecret.circom`, `agent/zkAuth.ts` |

Team: Farhan · Finja · Louisa

**Usage and value note** (problem, users, value for BSV, status): [`docs/USAGE_AND_VALUE.md`](USAGE_AND_VALUE.md).
**Use cases:** 20 scenarios for agents raising and giving: [`docs/USE_CASES.md`](USE_CASES.md). The donor agent: [section 6](#6-the-donor-agent-an-ai-that-gives-for-you).
**Self-assessment against the track criteria:** [`docs/JUDGING_REPORT.md`](JUDGING_REPORT.md).
**AI agent payments:** an autonomous agent raises its own budget on CryptoPledgePot and spends it on a pay-per-call API, one micropayment per call. See [section 5](#5-ai-agent-service-agentic-payments).
**NGO payment plans and the compliance agent:** [section 6b](#6b-ngo-payment-plans-and-the-compliance-agent) and [`docs/NGO_PAYMENT_PLAN.md`](NGO_PAYMENT_PLAN.md).
**API3 track** (the swap contract checks the rate against signed data): [section 7b](#7b-api3-price-guard-the-contract-checks-the-rate) and [`docs/API3_CROSSCHAIN_SWAP_GUARD.md`](API3_CROSSCHAIN_SWAP_GUARD.md).
**zk-SNARK agent authorization:** [section 5](#5-ai-agent-service-agentic-payments) and [`docs/ZK_AGENT_AUTH.md`](ZK_AGENT_AUTH.md).

---

## 1. System architecture and data flow

```
 Browser (React)                     CryptoPledgePot server (Express)                    BSV blockchain
 ───────────────                     ────────────────────────                    ──────────────
 WalletClient ──BRC-100──▶ BSV Desktop (keys, approvals)
      │
      │ createAction: escrow output + OP_RETURN memo ───────────────────────────▶ broadcast (Arcade)
      │ AtomicBEEF ──AuthFetch (BRC-103/104)──▶ /api/pledges
      │                                         SPV verify (Arcade headers)
      │                                         check escrow terms = campaign
      │                                         index (SQLite) ──▶ SSE live feed
      │
 creator: release ─ unsigned tx ──AuthFetch──▶ /release-signatures
      │                                         policy: goal met / donor vote
      │                                         arbiter wallet (wallet-toolbox)
      │◀──────────── arbiter SIGHASH_ALL sigs ── signs sighash IT computed
      │ creator sigs (createSignature) + OP_PUSH_TX preimage → signAction ──────▶ covenant enforced by miners
      │ AtomicBEEF ───────────────────────────▶ /api/spends (index follows the escrow)
      │
 donor: refund ── after refundAfter: donor sig only ────────────────────────────▶ nLockTime path (no server)
```

**Off chain (indexer):** campaign metadata, the pledge index, votes, progress
updates, and the BEEF needed to spend each escrow. **On chain:** the money and
the rules. Each escrow binds `sha256(campaign JSON)`, the creator, arbiter and
donor keys, the release schedule and the refund date. The index can be rebuilt
from the chain: campaigns and memos are `OP_RETURN` records (`core/campaign.ts`).

### Campaign lifecycle
| Status | When | What can happen |
|---|---|---|
| `active` | before the deadline, goal not reached yet | donations |
| `funded` | the goal is reached (at once, even before the deadline) | no more pledges; milestone 1 releases; later milestones need a creator update + YES from donors holding > 50% of pledged sats |
| `failed` | deadline passed, goal missed | arbiter co-signs immediate refunds |
| `completed` | all milestones released | nothing left in escrow |
| `breached` | an NGO's off-plan spending was not fixed within the grace period | no more releases; the arbiter co-signs early refunds of everything still escrowed |
| any | after `refundAfter` | donors reclaim whatever is still escrowed, **alone** |

### Trust model (honest version)
- **Donor safety needs no trust:** after `refundAfter` the contract lets the
  donor reclaim the remainder with only their own signature.
- **The creator can never take funds alone.** Every release needs the arbiter
  too, and the covenant limits each release to that milestone's share.
- **The arbiter** (vote oracle) is a server key. It cannot spend anything by
  itself. If the creator and arbiter collude, they could release milestones
  early, but only one tranche at a time and never past the schedule. The
  arbiter can be swapped for an M-of-N multisig without changing the app's
  architecture.
- All-or-nothing cannot stop a creator from backing their own campaign to reach
  the goal. That is true of every all-or-nothing platform.

---

## 2. The sCrypt contract: `contracts/src/contracts/cryptoPledgePotEscrow.ts`

```ts
export class CryptoPledgePotEscrow extends SmartContract {
  @prop() campaignId: ByteString      // sha256(canonical campaign JSON)
  @prop() creator: PubKey             // BRC-42 derived
  @prop() arbiter: PubKey             // vote oracle
  @prop() donor: PubKey               // BRC-42 derived
  @prop() pledged: bigint
  @prop() cumulativeBps: FixedArray<bigint, 4>   // e.g. [2500, 5000, 10000, 10000]
  @prop() refundAfter: bigint         // unix time

  @method(SigHash.ANYONECANPAY_SINGLE)
  public release(creatorSig: Sig, arbiterSig: Sig) {
    // stage = the one whose remaining amount equals this UTXO's value
    // → output i must be THIS script holding remaining(stage + 1)
    assert(found && (next == 0n || hash256(Utils.buildOutput(this.ctx.utxo.script, next)) == this.ctx.hashOutputs))
    assert(this.checkSig(creatorSig, this.creator))
    assert(this.checkSig(arbiterSig, this.arbiter))
  }

  @method() public refund(donorSig: Sig) {                     // trustless backstop
    assert(this.timeLock(this.refundAfter))
    assert(this.checkSig(donorSig, this.donor))
  }

  @method() public refundFailed(donorSig: Sig, arbiterSig: Sig) // campaign failed
}
```

Design notes:
- **Stateless.** The escrow's own value tells which milestone it is at, because
  remaining amounts strictly decrease (pledges must be ≥ 100 sats, so each 1%
  step frees ≥ 1 sat). This cut the script from 3.6 KB to 2.8 KB and removed
  sCrypt's state machinery (see `docs/DEVLOG.md` §3).
- **Batch releases.** The covenant preimage is `ANYONECANPAY|SINGLE`, so input
  *i* pairs with output *i* and many escrows release in one transaction. The
  signatures are `SIGHASH_ALL`, so nobody can redirect the released sats.
- **Timelock.** `OP_CHECKLOCKTIMEVERIFY` has been a NOP on BSV since Genesis,
  so the contract reads `nLockTime`/`nSequence` from the preimage (OP_PUSH_TX).

**Runtime without the sCrypt toolchain:** `core/pledge.ts` fills the compiled
template, parses scripts, builds BIP-143 preimages and unlocking scripts with
`@bsv/sdk`. A test checks it matches scrypt-ts **byte for byte**, and every path
is run by the SDK script interpreter.

---

## 3. Wallet and donation component

`app/src/components/DonateButton.tsx` (React) uses `client/cryptoPledgePot.ts`:

```ts
// app/src/wallet.tsx
const wallet = new WalletClient('auto')              // BSV Desktop over BRC-100
await wallet.waitForAuthentication({})
const cryptopledgepot = new CryptoPledgePot(wallet, new CryptoPledgePotApi(origin, wallet))

// DonateButton → cryptopledgepot.donate(meta, sats, { name, message })
const donorKey = await wallet.getPublicKey({ protocolID: [1, 'cryptopledgepot donor'], keyID, counterparty: 'self' })
await wallet.createAction({
  description: `Pledge to ${meta.title}`,
  outputs: [
    { lockingScript: pledgeScriptFor(meta, donorKey, sats).toHex(), satoshis: sats,
      basket: 'cryptopledgepot pledges', customInstructions: JSON.stringify({ protocolID, keyID, campaignId }) },
    { lockingScript: pledgeMemoScript(campaignId, memo).toHex(), satoshis: 0 }   // OP_RETURN
  ],
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})
// → AtomicBEEF posted with AuthFetch; the indexer verifies SPV and pushes it to the live feed
```

Release and refund use `createAction` + `signAction`. The app computes each
sighash and asks the wallet to `createSignature({ hashToDirectlySign })` with
the derived key, then assembles the sCrypt unlocking script.

---

## 4. Step-by-step: run it locally

Requires Node.js ≥ 22.

```bash
npm install
npm test                 # 149 tests: contract, CryptoPledgePot and agent end to end on the mock chain, plus the original token kit
```

**Explore the UI with no wallet (offline demo):**
```bash
npm run demo             # server :8787 + data API :8790 + agent :8791, mock chain, campaigns in every state incl. an AI agent
npm run app              # http://localhost:5174
```

**Real use on mainnet with BSV Desktop:**
```bash
# 1. Install and unlock BSV Desktop: https://github.com/bsv-blockchain/bsv-desktop/releases
npm run server           # indexer + arbiter on :8787 (Arcade SPV). Creates data/arbiter.key: back it up!
npm run app              # http://localhost:5174 → Connect wallet → Start a campaign / Donate
```
Env for the server: `CRYPTOPLEDGEPOT_ARBITER_KEY`, `NETWORK=main|test`, `PORT`,
`CRYPTOPLEDGEPOT_DB`, `ARBITER_WALLET_DB` (see `server/main.ts`).

**Recompile the sCrypt contract** (optional; the compiled artifact is committed):
```bash
cd contracts && npm install
npm run compile          # scrypt-cli compile + export the artifact to core/
npm run build && npm run crosscheck   # regenerate the byte-for-byte fixtures
cd .. && npm test
```

**Run everything with Docker:** see [`DOCKER_README.md`](../DOCKER_README.md) (one `docker compose up`).

**Let others test it over the internet** from your laptop with a fixed free
ngrok domain: `npm run share:internet` (setup and tester guide:
[`docs/SHARING.md`](SHARING.md)). Never tunnel `npm run app` (the dev
server); the share command serves only the built app.

### Repository map
| Path | What |
|---|---|
| `contracts/` | sCrypt contract (own TS 5 sub-project), compiled artifacts |
| `core/pledge.ts` | escrow runtime: script template, preimages, unlocks, schedule maths |
| `core/campaign.ts` | campaign model, id, validation, OP_RETURN records |
| `client/cryptoPledgePot.ts` · `client/cryptoPledgePotApi.ts` | wallet flows · HTTP/AuthFetch API client |
| `server/` | indexer + arbiter (`app.ts`, `policy.ts`, `db.ts`), `main.ts`, `demo.ts` |
| `app/` | React frontend |
| `core/paymentPlan.ts` · `core/compliance.ts` | NGO payment plan (validation, hash, signature) · spending checks, grace period, breach |
| `agent/` | AI agent service: loop (`agent.ts`), Claude brain (`brain.ts`), capped 402 payer (`pay402.ts`), spend ledger, paid data API, status endpoint, zk-SNARK authorization (`zkAuth.ts`) |
| `circuits/` · `scripts/deriveAgentCommitment.ts` | circom circuit for agent enrollment · its public commitment |
| `donor/` | donor agent: due diligence (`diligence.ts`, `screen.ts`, `score.ts`), brains, campaign search (`search.ts`), giving plans (`givingPlan.ts`), memos and inbox, local HTTP API |
| `compliance/` | compliance agent: notices, reminders, breach records (`complianceAgent.ts`, `main.ts`) |
| `swap/` | liquidity agent, donor-side swap, simulated and EVM source chains, API3 price and judge proof, EVM deploy and verify |
| `evm/` | Solidity: `HashedTimelockERC20`, `PriceGuardedHTLC`, the API3 libraries; `compile.cjs` → committed `artifacts.json` |
| `deployments/` | `api3-price-guard.json`, written by `npm run evm:deploy` (after the Base Sepolia deployment) |
| `test/pledge.script.test.ts` · `test/cryptoPledgePot.e2e.test.ts` | contract tests · end-to-end flows |
| `docs/DEVLOG.md` | engineering log: decisions, what broke, fixes |
| `overlay/`, `client/token.ts`, `web/`… | the BSV-21 token kit this project started from (still tested) |

### Costs (measured, 100 sat/kB mainnet policy)
- Donation: measured 3,458 bytes → 346 sats fee (≈ $0.00006 at $17/BSV), including the wallet's funding input and change.
- Releasing a milestone: ~6.2 KB per escrow → ~620 sats (≈ $0.0001).
  A 3-escrow release measured 18,650 bytes / 1,866 sats. Both figures are printed by `test/cryptoPledgePot.e2e.test.ts`.

---

## 5. AI agent service (agentic payments)

**An AI agent raises its own operating budget on CryptoPledgePot, gets paid milestone by
milestone as backers approve its work, and spends that budget on a
pay-per-call data API: one BSV micropayment per call, each one on chain and
linked in its report.**

![Agent campaign](screenshots/agent-campaign.png)

```
backers ──donate──▶ escrow ──milestone released──▶ agent's wallet (wallet-toolbox)
                                                        │ Claude plans which data to buy
                                                        │ capped HTTP 402 payer (BRC-121)
                                                        ▼
                                            paid data API ◀── 50 sats per call
                                                        │
             backers vote ◀── report + WhatsOnChain link per payment ──┘
```

Why CryptoPledgePot suits agents: backers can fund an autonomous agent **without
giving it a blank cheque**. Money stays in escrow and is released one milestone
at a time after a report and a vote. If the agent fails, backers reclaim what's
left.

**Safety: the LLM decides *what* to buy, code decides *how much*.**
- Plans are cut to whitelisted topics and a call cap (`sanitizePlan`).
- A per-milestone budget and a fee reserve.
- The payer reads the 402 price first and refuses hosts that aren't
  allow-listed and prices over the cap, before paying anything.
- Purchased data goes to the model as data, never as instructions.

**Watch it live, with no wallet and no sats:** `npm run demo:agent` (then
`npm run app`) plays **"AirWatch live"**. The agent launches its campaign,
five backers pledge, it withdraws milestones, pays a data API per call, refuses
an overpriced "premium" reading, reports, and backers vote, in about 1½
minutes. Everything is real code on the offline mock chain; only the pace is
staged. The demo banner shows each step; the agent panel shows what it's doing.

![AirWatch live: step 12](screenshots/live-2-agent-working.png)

**Run it on mainnet** (four terminals):
```bash
npm run server           # CryptoPledgePot indexer + arbiter
npm run data-provider    # the paid data API (:8790, 50 sats/call)
npm run agent            # the agent (:8791); --once for one step, --dry-run to plan without paying
npm run app              # web UI
```
1. On first start, the agent prints its identity key. It needs about 3,000
   sats for fees: open its campaign and click **Top up agent fees**, or send a
   BRC-29 payment to `/api/agent/fund`.
2. The agent launches its campaign (15-minute deadline by default). Back it from
   BSV Desktop.
3. After the deadline it withdraws milestone 1, buys data, and posts its report.
4. Backers vote in the UI, and it releases milestone 2.

`ANTHROPIC_API_KEY` switches on the Claude brain (`claude-opus-5-5` with
structured output and the server-side refusal fallback). Without it, a
deterministic mock brain is used. All limits are env vars (see
`agent/main.ts`).

The data is **synthetic** (deterministic per city and date, flagged
`synthetic: true`). The demo is about the payment rail; a real provider plugs in
behind the same middleware.

**Optional: zk-SNARK agent authorization.** A provider can sell its data only
to enrolled agents, without learning or storing their secret.

- **Enrollment:** the provider stores only a public Poseidon commitment to
  the agent's secret (`circuits/agentSecret.circom`).
- **Each call:** the agent makes a Groth16 proof locally (`agent/zkAuth.ts`,
  snarkjs) and sends it in `x-zk-proof` and `x-zk-signals`.
- **The check:** the provider verifies the proof **before** the BRC-121
  payment middleware. Without a valid proof it answers `401`, and no payment
  is taken.
- **Opt-in:** `ZK_AGENT_AUTH=1` with `ZK_AGENT_COMMITMENT` and
  `ZK_VERIFICATION_KEY` at the provider; `AGENT_ZK_SECRET`, `AGENT_ZK_WASM`
  and `AGENT_ZK_ZKEY` at the agent. Without them the API stays public, as
  above.
- **Limit:** proofs are not yet bound to a request, so one can be replayed
  while the commitment is enrolled. Use HTTPS; a nonce in the circuit would
  fix it.

Setup (circuit, trusted setup, keys): [`docs/ZK_AGENT_AUTH.md`](ZK_AGENT_AUTH.md).

**Tests** (offline, real wallet-toolbox wallets; 36 in all):
- `test/agent.pay402.test.ts`: price cap and allow-list.
- `test/agent.brain.test.ts`: hostile plans are sanitized; refusals fail safe.
- `test/agent.e2e.test.ts`: the full cycle with exact sat accounting, a greedy
  brain held to budget, an overpriced API refused, and the underfunded case.
- `test/agent.http.test.ts`: status, ledger, top-ups.
- `test/agent.zkAuth.test.ts` (snarkjs mocked: the wiring, not a real proof): proof headers never contain the secret, a matching commitment passes, a mismatched one is refused, and the headers go out with the first BRC-121 request.

Build log: `docs/DEVLOG.md` (agent steps 0–6).

---

## 6. The donor agent: an AI that gives for you

The other half of the agentic idea: an agent that **gives**, within your
terms (budget, interests, limits), and does the due diligence.

- **Co-pilot:** it finds and checks campaigns and proposes pledges with a short
  memo (score, reasons, every check). You approve and pay from **your own**
  BSV Desktop on the **My donor agent** page; the agent then verifies that
  pledge.
- **Autopilot:** you move a budget into the agent's own wallet; it pledges,
  verifies the payments linked in milestone reports and votes (or abstains
  without evidence), and reclaims money from failed or expired campaigns.

**Due diligence:**
- **Hard rules in code:** on topic, goal limit, time to deliver, no 1%/99%
  milestone traps, creator track record, budget, per-pledge and per-creator
  caps.
- **Independent checks:** the anchor is **SPV-verified by the agent itself**;
  the arbiter must be the platform's; an AI-agent campaign's ledger must be
  receipted.
- **A 0–100 score with reasons.** Campaign text that tries to instruct AI
  agents **disqualifies** the campaign.

- **Payment plans:** it votes NO on more money for an NGO that has not
  accounted for the last tranche, counts a breach against the creator's
  record, and reclaims escrow from breached campaigns.

**Find campaigns from a few words:** "children in need" → the open campaigns
that fit, best first, each with a two-sentence summary of what it does, how
far it is funded, how long is left, and warnings from code (e.g. text that
tries to steer AI agents). Claude ranks and summarises when
`ANTHROPIC_API_KEY` is set; otherwise an offline keyword and theme matcher is
used. The model can only pick campaigns from the index.

```bash
npm run donor:search -- children in need                 # from the terminal (read-only, no wallet)
```

**Giving plans:** "every month for a year, 5000 sats to children in need; if
nothing fits, ask me". The agent turns this into a draft you confirm, then:

- **Good match** (≥ 70% relevance): it gives on its own, within your
  mandate's hard rules, due diligence and budget.
- **Only a weaker match:** it does what the plan says. It asks you (the
  default, with the top options), gives to the closest match on its own, or
  skips.
- **Nothing similar:** it asks you, or skips and tells you. A question you
  don't answer within 72 h is skipped, or goes to the closest match if the
  plan says so.

In co-pilot, each installment is a proposal you approve. Messages and
questions appear on the **My donor agent** page. With `DONOR_NOTIFY_URL` they
are also pushed to your phone, e.g. through an `https://ntfy.sh/<topic>` URL.

```bash
cp donor-mandate.example.json data/donor-mandate.json   # your terms; "mode": "copilot" or "autopilot"
npm run donor                                            # your agent, on 127.0.0.1:8792 (personal: never exposed)
npm run app                                              # → My donor agent
```

![Donor agent, co-pilot](screenshots/donor-copilot.png)

**Tests:** 48 (`donor.rules`, `donor.e2e`, `donor.http`, `donor.search`,
`donor.givingPlan`). Design: [`docs/DONOR_AGENT_PLAN.md`](DONOR_AGENT_PLAN.md).

---

## 6b. NGO payment plans and the compliance agent

NGOs sign a **payment plan** before launch: for each milestone, the budget
lines, who gets paid and what share. They also accept a 10% tolerance, 30 days
to report and a 7-day grace period. The plan is fixed into the campaign id and
every escrow, and the creator's signature over it is checked by anyone.

- After a release, the NGO pays vendors from its wallet (`payPlanLine`,
  checked by SPV) or reports auditor-signed invoices.
- **The next milestone is co-signed only once the last one's spending matches
  the plan.**
- Off-plan spending starts a 7-day grace period: fix it, or pay the
  unaccounted sats back to the donors pro rata, in one transaction.
- After the grace period the campaign is **in breach**: no more releases, and
  early refunds of all remaining escrow. The compliance agent writes a
  breach record on chain.

The arbiter enforces these rules even if the compliance agent is down; the
agent tells the NGO what to spend and by when, sends reminders, opens the
grace period publicly and notifies donors at a breach. The web app has a plan
builder (Create), a compliance view and repayments (Campaign page).

```bash
npm run compliance       # watches every plan campaign: notices at http://127.0.0.1:8793/api/compliance
```

**What the chain cannot do:** money already released is in the NGO's wallet,
and no script can pull it back. The plan adds a repayment window, a permanent
breach record, a worse track record with every donor agent, and signed terms
as the basis for a claim.

**Tests:** 39 (`paymentPlan`, `paymentPlan.e2e`, `compliance`,
`compliance.e2e`). Design and limits: [`docs/NGO_PAYMENT_PLAN.md`](NGO_PAYMENT_PLAN.md).

---

## 7. Bring USDC in: cross-chain swaps with no custodian

A donor who holds **only USDC on another chain** can end up with sats in
**their own** BSV wallet, and back a campaign, without anyone ever holding
their funds. It works as an **atomic swap**: the same secret unlocks a
USDC lock on the other chain and an sCrypt `AtomicSwap` lock on BSV. Either
both sides complete, or each refunds its own money after its timeout.

- **The donor's agent** checks the liquidity agent's BSV lock itself (SPV,
  same hash, pays the donor's key, full amount, safe timeout) before
  claiming. It refuses, and refunds, otherwise.
- **The liquidity agent** checks the donor's USDC lock on the other chain
  before locking any sats, then collects the USDC by reading the secret from
  the donor's BSV claim.
- The BSV timeout is always shorter, so the donor can always claim first.
  The claim needs the donor's signature, so a copied secret can't redirect
  it.
- A newcomer needs **no BSV to start**: the claim's fee comes out of the
  swapped sats.

```bash
npm run demo:swap      # "Fay has only USDC": narrated, offline, ~30 s (DEMO_PACE_S=2)
npm run demo:bridge    # the same with a real Solidity HTLC on a local EVM chain (Anvil)
```

**Honest scope:** the BSV side is real (sCrypt, real wallets, the mock
chain validates every script). The USDC side has two implementations behind
one `SourceChain` interface: a simulated HTLC ledger (`demo:swap`) and a
**real Solidity HTLC** (`evm/contracts/HashedTimelockERC20.sol`) driven with
viem on a local EVM chain (`demo:bridge`, `swap/evmChain.ts`). A public
testnet is not run yet. Plans: [`docs/CROSS_CHAIN_PLAN.md`](CROSS_CHAIN_PLAN.md),
[`docs/BRIDGING_PLAN.md`](BRIDGING_PLAN.md).

### 7b. API3 price guard: the contract checks the rate

Hash locks make a swap atomic, not fair. `PriceGuardedHTLC` closes that gap:
the donor's USDC can only be locked if the sats the liquidity agent quoted are
within ±2% of a BSV/USD price that CoinPaprika's Airnode on **API3
AirnodeHub** signed moments ago.

- The contract verifies the Airnode v2 signature against the Airnode address
  and request hash fixed at deployment, then the response's and the price's
  age, then the rate. There is no owner and no unchecked `lock()`.
- The liquidity agent pays 0.001 aUSD per signed price (x402) and quotes from
  it, so an honest quote always passes; a greedy one never locks the donor's
  money.
- A real Nodary-signed API3 response passes the same verification code.
- **Tamper test for judges:** `npm run api3:judge` runs the API3 track's
  test against the deployed contract with the judge's own responses: a valid,
  timely response locks USDC (a transaction), then a response with one value
  edited, one that is too old, one to a different request and one signed by
  another key are each refused before the lock. `--local` runs it on Anvil.
- One swap's hashlock can lock only once (`HashlockAlreadyUsed`).

**Tests:** 15 (`api3.guard.evm`, `api3.proof.evm`). Details, design decisions
and the judges' guide: [`docs/API3_CROSSCHAIN_SWAP_GUARD.md`](API3_CROSSCHAIN_SWAP_GUARD.md).

### Known limitations
- Not yet exercised with a real BSV Desktop wallet on mainnet; the identical
  code runs end to end against wallet-toolbox wallets in the tests. The agent's
  mainnet start-up was smoke-tested and stops cleanly at "insufficient funds"
  until it is topped up.
- The agent's Claude brain has only been tested with a scripted client (no API
  key in the build environment).
- BRC-121 sends the payment BEEF in a header; at 0-conf after a release it
  reached 35 KB, so paid APIs (and any proxy in front) need a raised header
  limit (`serveDataProvider` uses 1 MB).
- The arbiter is a single key; an M-of-N guardian set is the next step.
- `PriceGuardedHTLC` runs on Base Sepolia, but the full USDC → BSV swap
  has only run on a local EVM chain; on Base Sepolia it locks the
  project's TestUSDC, not Circle's.
- zk-SNARK proofs are not bound to a request, so one can be replayed while
  the commitment is enrolled; the circuit needs its own trusted setup.
- Money an NGO has already been paid cannot be pulled back by a script; a
  payment plan makes breaches public and refundable only for what is still
  escrowed.
- If a refund or release is not reported to `/api/spends`, the index stays
  stale until someone reports it; a chain watcher (Arcade/WoC spent lookups)
  would close that gap.

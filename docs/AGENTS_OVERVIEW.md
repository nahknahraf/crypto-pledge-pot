# The three agents: what each one is, alone

Each agent:

- is its own process, with its own wallet and its own state file;
- talks to the others only through public interfaces: the CryptoPledgePot HTTP API, the chain, and HTTP 402 or HTTP JSON;
- trusts nothing it is told: every claim is checked on chain.

You can run, test and reason about each one without the others.

```
                       CryptoPledgePot server (index + arbiter)  ◄── chain (BSV)
                          ▲ HTTP (BRC-103 auth)          ▲
   Fundraising agent ─────┘                              └───── Donor agent
     │ pays per call (BRC-121, HTTP 402)                          │ (co-pilot: the human pays)
     ▼                                                            │ swaps USDC first, if needed
   Data provider (paid API)                    Liquidity agent ◄──┘ HTTP JSON + HTLCs on both chains
```

## Card format

Every agent is described the same way:

- **Job:** what it is for, in one line.
- **Runs as:** the command and port.
- **Holds:** the money it can touch.
- **State:** where its state lives.
- **Loop:** what one step does.
- **Never:** invariants enforced in code (not by the model).
- **Alone:** how to test it without the other agents.

---

## 1. Fundraising agent (`agent/`)

| | |
|---|---|
| **Job** | Raise its own budget on CryptoPledgePot, buy data per call, report to backers |
| **Runs as** | `npm run agent` (status: `:8791/api/agent`). Needs `npm run server` and `npm run data-provider` |
| **Holds** | Only what backers already released to it (milestone by milestone), plus a fee float topped up via BRC-29 |
| **State** | `data/agent-state.json` (campaign, milestones worked), `data/agent-ledger.json` (every payment: url, sats, txid, `failed`) |
| **Loop** | launch campaign once → wait → release the approved milestone → plan purchases (Claude or mock) → pay per call → anchor the report hash on chain → post the report → wait for the vote |
| **Never** | pays above `pricePerCall` or outside the allow-list (`pay402.ts`); spends more than `maxSpendPerMilestone` per milestone, **across restarts** (the budget is computed from the ledger); posts a report before its anchor exists; works a milestone twice |
| **Alone** | `agent.e2e`, `agent.pay402`, `agent.trust`, `agentDemo.e2e`; `npm run demo:agent` |

The model only chooses *what* to buy and writes the text. Prices, caps, hosts and amounts are decided in code.

## 2. Donor agent (`donor/`)

| | |
|---|---|
| **Job** | Give on a person's behalf within a written mandate (budget, interests, rules) |
| **Runs as** | `npm run donor` (status and approvals: `127.0.0.1:8792`, the "My donor agent" page) |
| **Holds** | **Co-pilot:** nothing; the human pays from their own BSV Desktop. **Autopilot:** only the budget the human moved into its wallet |
| **State** | `data/donor-memos.json` (one memo per decision: checks, score, reasons, txids) |
| **Loop** | list campaigns → hard rules → due diligence (SPV-verified anchor, arbiter key, an agent's ledger against its published limits) → model judgement → score → amount → pledge (autopilot) or propose (co-pilot) → for backed campaigns, verify reports and vote → reclaim from failed ones |
| **Never** | exceeds the budget or per-creator cap; pledges twice to one campaign; pays in co-pilot; funds text that addresses AI agents (a rule in code, for every brain, so the campaign scores 0); votes YES without verified evidence, or on a report that differs from its on-chain anchor; trusts terms the server shows unless they hash to the anchored campaign id; evaluates more than `maxEvaluationsPerStep` campaigns per round |
| **Alone** | `donor.rules`, `donor.e2e`, `donor.http`; `npm run demo:donor` |

## 3. Liquidity (bridging) agent (`swap/`)

| | |
|---|---|
| **Job** | Sell sats for USDC on an EVM chain, BTC on chain, or BTC over Lightning, atomically, so a donor with no BSV can pledge |
| **Runs as** | `npm run lp` (`:8793/api/lp`: `GET` status, `POST /quote`, `POST /lock`). Configured by env (`swap/lpMain.ts`) |
| **Holds** | Its own sats inventory (BSV) and the USDC it collects (EVM). **Never the donor's money**: the donor's USDC sits in an HTLC that only the secret or the timeout can open |
| **State** | `data/lp-swaps.json`: every quote and lock. It is saved before and after each lock, so a restart still collects or refunds |
| **Loop** | `quote` → `acceptSourceLock` (reads the donor's lock **on the EVM chain**: pays us, right amount, long enough timeout, not already used) → lock sats on BSV for the donor's key, with an earlier timeout → `step`: when the donor claims, read the secret from the BSV claim and claim the USDC; if they never claim, refund our sats after our timeout |
| **Never** | locks sats before seeing the source lock on chain with `minSourceConfirmations`; loses track of a lock it broadcast (a `locking` intent is saved first and recovered from the wallet basket); accepts one source lock for two swaps (including concurrent requests); quotes above its limit or its inventory; lets its timeout end after the donor's |
| **Alone** | `swap.edges`, `swap.e2e` (simulated USDC), `bridge.evm` and `bridge.service` (real Solidity HTLC on Anvil, the agent over HTTP, a crash and restart), `bridge.btc` (P2WSH HTLC on a Bitcoin Core regtest node), `bridge.lightning` (hold invoices on two LND nodes); `npm run demo:bridge`, `npm run demo:bridge:btc`, `npm run demo:bridge:ln` |

The donor side of a swap (`swap/donorSwap.ts`) is a library, not a separate agent:

- it makes the secret and locks the USDC;
- it **re-checks the BSV lock itself** (SPV, hashlock, its key, amount, timeout) before claiming;
- it works with the in-process agent or the HTTP `LiquidityClient`, because both implement `LiquidityProvider`.
- the USDC can be locked three ways:
  - from USDC the donor holds (`approve` + `lock`);
  - with a permit, in one transaction;
  - swapped from another token on a DEX through `SwapAndLock`, in one transaction (`lockAndRequest(…, lockWith)`);
- in a browser, the donor's own EVM wallet signs (`swap/browserEvm.ts`), and `swap/browserSwap.ts` runs the whole flow for the **Bring USDC** page.

The source chain is pluggable: `SourceChain` (`swap/usdcChain.ts`) has an `asset` (USDC, 6 decimals, by default; BTC, 8). `EvmUsdcChain`, `BtcChain` and `LightningChain` implement it, so the agent and the donor library don't know which chain they're on. Two optional hooks cover Lightning: `request` (the agent issues a hold invoice first) and `release` (it cancels that invoice when it gives up).

Money can also come in without a swap: **Fund from an exchange** (`client/receive.ts`) gives a fresh deposit address of the user's own wallet.

## Supporting services (not agents)

| Service | Job | Command |
|---|---|---|
| CryptoPledgePot server | Index campaigns and pledges; arbiter co-signature by policy (milestone 1 when funded, later milestones by a >50 % vote, refunds when failed) | `npm run server` |
| Data provider | The paid API the fundraising agent buys from (BRC-121), real Open-Meteo data | `npm run data-provider` |

## Reasoning about failures

| If this fails… | …then |
|---|---|
| The server is down | Donors still reclaim after `refundAfter` from chain data alone. Agents' steps fail cleanly and resume |
| The model misbehaves | Every money decision is in code: caps, rules, amounts. The model's output is range-checked |
| The data provider takes money and fails | The payment is recorded as `failed`, counts against the cap, and is not retried |
| The liquidity agent crashes mid-swap | Its state file has the lock, so on restart it collects or refunds. The donor can always refund their USDC after the timeout |
| The liquidity agent lies | The donor's agent checks the BSV lock on chain and refuses to claim, then gets the USDC back after the timeout |

# What works (2026-10-31)

Each line says how it was verified:
- **mainnet**: done for real, on BSV mainnet.
- **live**: run against real services, nodes or Claude.
- **tested**: covered by `npm test` (292 tests, plus 3 opt-in).
- **built**: code is there, never run end to end.

How to run each thing: [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md).

## The platform

| What | Status |
|---|---|
| Campaigns anchored on chain; pledges into sCrypt escrow contracts, one per donation | **tested**; earlier mainnet use (see `USAGE_AND_VALUE.md`); **mainnet** (run 1 below) |
| Milestone releases: milestone 1 once funded; later milestones by a pledge-weighted vote over 50 % | **tested** |
| Refunds: after the deadline with the arbiter's co-signature; after the refund date without the server | **tested** |
| Reports hashed on chain before posting (can't be edited later) | **tested**; **live** with Claude |
| Web app: browse, create, donate, vote, reclaim, "Find my pledges", Fund from an exchange, Bring USDC, Bring BTC | **tested** (logic); the pages build; the Bring pages haven't been clicked through with real wallets |
| Server: index, arbiter, chain watcher, one server per index | **tested** |
| Docker / Podman: Caddy + server + data provider + agent; offline demo profile | see `DEMO_RUNBOOK.md` §2 for what was built and run |

## The agents (each in its own folder, each works alone)

| Agent | What works | Status |
|---|---|---|
| **Fundraising agent** (`fundraising-agent/`) | Launches its own campaign, with terms built from one spending plan; pays per API call (HTTP 402, capped, allow-listed); remembers refused purchases and re-plans; anchors and posts reports; releases milestones | **tested**; **live** with Claude (API and Claude Code); **mainnet**: launched its campaign by itself in run 1 |
| **Donor agent** (`donor-agent/`) | Co-pilot (proposes; the person pays) or autopilot (own budget). Checks anchors by SPV, the agent's ledger against its published limits, and reports against their on-chain anchors; votes; reclaims. Text aimed at AI agents scores 0 | **tested**; **live** eval with Claude through the API: every row 3/3; **mainnet**: two pledged by themselves in run 1 |
| **Liquidity (bridging) agent** (`liquidity-agent/`) | Atomic swaps into BSV sats from **USDC** (Solidity HTLC, permit, a DEX swap and lock in one transaction), **BTC on chain** (P2WSH HTLC) and **Lightning** (hold invoices). The donor's side works from any wallet (WebLN or a shown invoice; a BTC refund ticket) | **tested**; **live** on Anvil, a Base mainnet fork (real USDC and Uniswap), Bitcoin Core regtest, two LND nodes; no public-network swap yet |

## Zero-click (only agents, nobody approving)

| What | Status |
|---|---|
| `npm run rehearse:agents`: the whole story with only agents, offline | **live** with Claude: completed with 3/3 milestones, 15 real Open-Meteo purchases, 0 human actions |
| `npm run agents:mainnet`: server, data provider, fundraising agent, 3 autopilot donor agents, team treasury | **mainnet** run 1 (2026-10-31): one deposit was claimed by SPV and all 4 agents were funded by themselves; the agent launched its campaign. 2 donor agents pledged (score 61) and 1 declined (55), so 1,000 of the 1,200-sat goal was raised; outcome in `DEVLOG.md` |
| Donor budgets now let any 2 of the 3 donors reach the goal | **tested** (fixed after run 1); not yet run |

## Safety and operations

| What | Status |
|---|---|
| Every money decision in code (caps, amounts, rules); the model only judges | **tested**; **live** |
| Wallet monitors running (proofs, broadcast retries); without them, agents stop after ~12 chained payments | **live** on a throwaway mainnet wallet |
| Secrets in one file outside the repo (`docs/KEYS.md`); tests can't read it | **tested** |
| `npm run preflight`: read-only check before a recording | **tested**; **live** |
| Contract hardening: Slither, a reentrancy guard, a model-based fuzz test (5 seeds × 200 steps) | **tested** |

## Not done

- A swap on a public network, and the real-wallet click-through of the Bring pages.
- A second human reviewer for the lock contract.
- An on-ramp, which needs your choice of provider and its account.
- The video recording.

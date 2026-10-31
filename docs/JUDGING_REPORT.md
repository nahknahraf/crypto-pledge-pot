# CryptoPledgePot: report and score against the BSV track criteria

*30 October 2026 · branch `judging-prep` (on top of the merged `master`) ·
149 tests passing, both type-checks clean · an honest self-assessment, not a
pitch*

## Qualification gate

| Requirement | Status | Evidence |
|---|---|---|
| BSV SDK + Wallet Toolbox | ✅ | `@bsv/sdk` throughout; wallet-toolbox for the arbiter, agent, data provider, donor agent and liquidity agent |
| User flows with BSV wallets | ✅ | BSV Desktop donate/vote/claim flows; a real mainnet campaign + pledge exist (`c1309193…`, `0e637517…`) |
| Real transactions | ⚠️ partial | Mainnet anchor + pledges only. **No mainnet release, refund or agent payment yet** |
| Non-custodial | ✅ | sCrypt escrow (creator + arbiter, tranche by tranche, donor self-refund); atomic swaps; agents hold only released tranches or their own budget |
| AI agent makes a payment | ❌ on mainnet / ✅ offline | Agent pays per call (BRC-121) on the mock chain with full tests; **never on mainnet; Claude never called live** |
| README, video, tx links, usage note | ⚠️ | README + usage note exist (the usage note's test count is stale); **no video, no link table** |

**Verdict: does not qualify yet.** It passes once the plan's mainnet run R1
is done (needs ~10,000 team sats and an Anthropic key), the links are added,
and the video is recorded.

## Scores (out of 100)

| Criterion | Weight | Before today | Now | Why it moved, and what holds it back |
|---|---|---|---|---|
| Adoption | 35 | 17 | **21** | + real Open-Meteo data resold per call; + the donor agent; + donors from other chains (USDC swap demo). − The USDC side is simulated; no real users or mainnet run |
| BSV stack | 25 | 20 | **21** | + on-chain report records; BRC-100/42/29/121/103-104, BEEF/SPV, Arcade, sCrypt ×2, wallet-toolbox in 5 roles. − Few mainnet transactions |
| Technical / non-custodial | 20 | 15 | **18** | + published, audited spending limits; + restart safety; + chain watcher, re-import, legacy support; 149 tests. − Single arbiter key; no CI |
| Agentic payments | 10 | 5 | **6** | + visible reasoning, refusals, audit by donor agents. − Not on mainnet, Claude not live |
| Originality / presentation | 10 | 6 | **7** | + "AirWatch live", "Fay has only USDC", two-sided agent economy. − No video |
| **Total** | 100 | ≈63 | **≈73** | |

**Reachable with the gate items done:** about **80–82**. Mainnet R1 adds
≈ +3 agentic and +2 stack; the video adds +2 presentation; the link table and
a refreshed usage note add +1.

## What was implemented today for this report

1. `donor-agent` + `cross-chain-swap` merged into `master`.
2. Real air-quality data from Open-Meteo (with labelled synthetic fallback).
3. Agent spending limits published in the anchored campaign terms and
   audited by the donor agent.
4. Milestone reports anchored on chain by hash, with verification.
5. Restart-safety test.

## Still open (in order)

1. **Mainnet run R1** (`docs/FUNDRAISING_AGENT_PLAN.md` §3): sats + an
   Anthropic key needed.
2. Fill the transaction-link table in `docs/USAGE_AND_VALUE.md` from R1
   (the table and the refreshed status are in place; 2 existing mainnet
   links listed).
3. **Video** (`docs/DEMO_SCRIPT.md`).
4. Point ngrok at port 8081 for the public URL.

Done since this report was first written: the README pitch and the
feature → BRC/package → code table; the usage note's status (both agents,
swaps, real data, 149 tests).

## Added since (31 October 2026, branch `finja-and-louisas-branches`)

The scores above are not re-rated; this is what was built after them.
**237 tests** pass now, both type-checks clean.

- **NGO payment plans and the compliance agent:** a signed plan per
  milestone, releases gated on SPV-checked spending, grace period, pro-rata
  repayment, breach records and early refunds (39 tests).
- **Donor agent:** campaign search from a few words; giving plans on a
  schedule that ask the donor when nothing fits (24 more tests).
- **Real EVM side of the swap** on a local chain (Solidity HTLC + viem), and
  the **API3 price guard**: the contract checks the rate against signed
  BSV/USD data; judges can re-run a tamper test with their own response
  (13 tests). Base Sepolia is still to do.
- **zk-SNARK agent authorization** at the paid data API (Groth16, checked
  before payment; 5 tests with snarkjs mocked, no real proof generated yet).

None of these changes the gate verdict: the mainnet run R1, the link table
and the video are still open.

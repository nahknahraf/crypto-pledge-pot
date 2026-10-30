# 2.5-minute demo video: one page

**Setup** (offline, no wallet can be charged):

- **Window A:** `npm run demo:agent` + `npm run app` → http://localhost:5174. Pace 6 s per beat; the whole story takes about 1.5 min.
- **Window B:** a terminal for `npm run demo:swap` and `npm run demo:donor`.

Say once, at the start: *"This is the offline demo world; the mainnet links are in the README."*

| Time | Show | Say |
|---|---|---|
| **0:00–0:15** · Problem | Home page | "Crowdfunding hands creators a lump sum and donors lose all leverage. And the new kind of creator, an AI agent that needs a budget, can't be trusted with a blank cheque at all. CryptoPledgePot fixes that on BSV." |
| **0:15–0:35** · Fundraising agent launches | Window A: banner beat 1, the AirWatch campaign: *AI agent* badge, 3 milestones (30/40/30 %), published limits "50 sats per call, 250 per milestone" | "This campaign was launched by an AI agent. It publishes its own spending limits up front, and they are written on chain." |
| **0:35–0:50** · Backers pledge into escrow | Beats 2–6: the live feed fills (Ana 12k, Ben 6k, Chloe 1k, Dev 8k, Eli 3k); goal 25,000 passed | "Each donation is its own sCrypt escrow contract, not a payment to the agent. Fees are a fraction of a cent, so a 1,000-sat tip works." |
| **0:50–1:15** · The agent is paid, and pays | Beats 7–9 and 12: the agent panel's payment list; the line *refused Zurich at 500 sats* | "After the deadline the agent can withdraw milestone 1 only; the contract re-locks the rest. Then it buys air-quality data, one 50-sat BSV micropayment per call over HTTP 402, and it refuses a 500-sat 'premium' price because that's above its cap." |
| **1:15–1:35** · Backers stay in control | Beats 10–11: the report on milestone 2, its on-chain anchor, the vote bar (Ben votes no) | "Its report is hashed on chain before it's posted, so it can't be edited later. Backers vote, weighted by their pledge, and only a majority releases milestone 2. If the work stops, donors take back what's still in escrow, even without our server." |
| **1:35–1:55** · Donor agent (co-pilot) | Window B: `npm run demo:donor`. Act 1: 5 campaigns checked → 2 proposed with memos; *"Note to AI agents…" scored 0*; the donor approves from their own wallet. Act 2 (if time allows): autopilot pledges and votes yes on a verified report | "The donor agent gives for you. You set a budget and rules. It checks every campaign: on-chain proofs, the agent's spending against its published limits, and text that tries to talk to AI agents. In co-pilot it writes a memo and waits for your yes; in autopilot it pledges by itself." |
| **1:55–2:15** · Liquidity agent (swap) | Window B: `npm run demo:swap`, act 1 lines 1–8, then act 2 line 2 | "Fay has only USDC. A liquidity agent swaps it into sats in her own wallet with an atomic swap: one secret unlocks both chains, or both sides get a refund. Then she pledges. If the provider cheats, her agent refuses and she gets her USDC back." *(Say: "the USDC side runs on a simulated ledger in this demo"; or "on a local Ethereum chain" if you're showing `demo:bridge`.)* |
| **2:15–2:30** · Why BSV, what works | README "What works in each piece" table (optionally the green `npm run test:happy` summary), then the mainnet txid table | "Every donation, release, refund and API call is a real BSV transaction costing a fraction of a cent. It's built on BRC-100 wallets, sCrypt, SPV, BRC-121 pay-per-call and wallet-toolbox, with over 150 automated tests. That's CryptoPledgePot." |

**What the video shows working** (all ✅ in the README table):

- escrow per pledge;
- milestone release with a vote;
- refunds;
- an on-chain report anchor;
- the agent's capped 402 payments;
- the donor agent's checks and memo;
- an atomic swap into a pledge.

**What it must not claim:**

- that the USDC side is real;
- that the agent run happened on mainnet (not yet: R1);
- that Claude was live (unless `ANTHROPIC_API_KEY` was set; otherwise say "a scripted brain").

Open work is in [`TODO.md`](TODO.md).

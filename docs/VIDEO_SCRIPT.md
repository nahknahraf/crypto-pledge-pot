# 2.5-minute demo video on mainnet: one page

> **Zero-click version (recommended):** nobody clicks or approves anything once the agents run. See the section at the end of this page. The original version with human backers follows.

Everything in the video is **BSV mainnet**: real sats, BSV Desktop, WhatsOnChain links. Record the run live and cut the waiting in editing; deadlines take minutes. Every cut should land on a WhatsOnChain page, so viewers can see that the step really happened.

**Before recording** (budget about 12,000 sats from **team** wallets; never a personal wallet):

1. Run `npm run server`, `npm run data-provider` (real Open-Meteo data) and `npm run app`. Check that `/api/health` says `main` and that the app shows mainnet.
2. Start the agent with short, cheap terms and the Claude brain. Its goal and spending cap are derived from one spending plan (5 readings × 50 sats + 150 sats of fees per milestone = 1,200 sats in total; `fundraising-agent/campaignPlan.ts`):

   ```
   AGENT_DEADLINE_MIN=15 npm run agent
   ```

   The API key is loaded from `~/.config/cryptopledgepot/secrets.env` (`docs/KEYS.md`); don't type it on the command line. The start-up line must say `brain claude:…`. Top it up with about 3,000 sats from BSV Desktop, using **Top up agent fees** on its campaign page.
3. Donor agent: copy `donor-mandate.example.json` to `data/donor-mandate.json`, put in backer 1's identity key, and keep it in `copilot` mode. Then run `npm run donor`.
4. Launch a second, tiny campaign from the app (goal 1,000 sats, deadline 10 minutes) and pledge 600 sats to it, so it fails during the recording.
5. Have two BSV Desktop wallets ready (backer 1 and backer 2), with about 4,000 sats each. Keep a WhatsOnChain tab and the agent's terminal visible.
6. **For the closing shot:** record `DEMO_PACE_S=1 npm run demo:bridge:ln` in a terminal beforehand (about 20 s, fully local; needs bitcoind and lnd in `~/opt`, see `docs/BRIDGING_PLAN.md` §4), and caption it **"local test network"** on screen.

| Time | Show (mainnet) | Say |
|---|---|---|
| **0:00–0:12** · Problem | Home page, connected to BSV Desktop on mainnet | "Crowdfunding hands creators a lump sum, and donors lose all leverage. An AI agent that needs a budget can't be trusted with a blank cheque at all. CryptoPledgePot fixes that, live on BSV mainnet." |
| **0:12–0:30** · The agent launches | Agent terminal: `brain claude:…`, the campaign launch. Campaign page: *AI agent* badge, 2 milestones (40 / 60 %), its published limits. Click the anchor → WhatsOnChain | "This campaign was launched by an AI agent. Its terms and its spending limits are written on chain: here's the transaction." |
| **0:30–0:50** · Backers pledge | Backer 1: Donate 3,000 → the app's confirm dialog (amount, mainnet) → BSV Desktop approval → the live feed → the escrow output on WhatsOnChain. *(Cut: backer 2 pledges.)* | "I back it from my own wallet. The sats don't go to the agent: they go into an sCrypt escrow contract, one per donation, for a fraction of a cent in fees." |
| **0:50–1:15** · The agent is paid, and pays | *(Cut past the deadline.)* Terminal: milestone 1 released, Claude's plan, the `paid 50 sats …` lines. The agent panel's payment list → a txid → WhatsOnChain | "After the deadline the agent can withdraw milestone 1 only; the contract keeps the rest locked. Claude picks which data to buy; code decides how much. It pays 50 sats per API call over HTTP 402 and refuses anything above its cap. Every payment is on chain." |
| **1:15–1:35** · Backers stay in control | The milestone 2 report and its on-chain anchor (WhatsOnChain); backer 1 clicks **Approve** and confirms in BSV Desktop; *(cut)* terminal: milestone 2 released | "Its report is hashed on chain before it's posted, so it can't be edited later. Backers vote, weighted by what they pledged. Only a majority releases the next milestone." |
| **1:35–1:55** · Donor agent (co-pilot) | **My donor agent** page: memos with their checks (SPV anchor, arbiter, the agent's spending against its published limits); a proposal → **Approve & pay** → BSV Desktop → the pledge on WhatsOnChain | "My donor agent screens campaigns for me: on-chain proofs, whether an AI agent kept to its own limits, and text that tries to manipulate AI agents. It writes a memo and waits. I approve and pay from my own wallet; the agent never holds my money." |
| **1:55–2:12** · Refund | The tiny campaign that missed its goal → **Reclaim (campaign failed)** → BSV Desktop → the refund on WhatsOnChain | "If a campaign fails, donors take back what's in escrow right away, and after the refund date they can even do it without our server." |
| **2:12–2:30** · Why BSV, and money from other chains | The mainnet txid table in `USAGE_AND_VALUE.md`, then the pre-recorded `demo:bridge:ln` terminal (captioned **local test network**): *hold invoice → held → sats locked → claimed → settled* | "Every donation, release, payment, vote and refund you saw is a mainnet transaction. Donors don't even need BSV: a liquidity agent atomically swaps USDC, Bitcoin or Lightning into sats in their own wallet. Here it is on real Bitcoin and Lightning nodes, on a local test network." |

**Capture while recording** (into `docs/USAGE_AND_VALUE.md`):

- the campaign anchor;
- 2 donations;
- the release of milestone 1;
- at least 2 agent API payments;
- the report anchor;
- a vote;
- the release of milestone 2;
- the co-pilot pledge;
- the refund.

**Must not claim:**

- that a swap ran on mainnet or on a public testnet. So far the swaps have run only on local test networks:
  - USDC: Anvil, and a local fork of Base with the real USDC and Uniswap contracts;
  - Bitcoin and Lightning: Bitcoin Core and LND in regtest;
  - the BSV side: the offline mock chain.

  Say "local test network", and keep the caption on screen;
- that the Bring USDC or Bring BTC page was used with real wallets (it hasn't been clicked through yet);
- that the brain was Claude, if the start-up line said `brain mock`.

**Before you start:**
- Run `npm run preflight`. It checks, read-only, that:
  - the server is on mainnet;
  - the data provider serves real data;
  - the agent runs the Claude brain, has a campaign and a fee float of at least 3,000 sats;
  - the donor agent is in co-pilot mode;
  - the key is set, the app is up, and BSV Desktop is listening.

  It exits non-zero if anything is wrong. It never calls the wallet or spends.
- Check that no browser automation is running while BSV Desktop is open. Every payment in the video is clicked and approved by a person.

Open work is in [`TODO.md`](TODO.md).

## Zero-click version: only agents, nobody approving anything

**Before recording**
1. Rehearse offline with the same agents and brains: `npm run rehearse:agents`. It should end with `campaign completed, 3/3 milestones released … Human actions: 0`.
2. Start everything: `npm run agents:mainnet`. That's the server, the data provider, the fundraising agent and 3 autopilot donor agents.
3. Make **one** payment of the amount it prints (about 7,500 sats) to the deposit address it prints, from any wallet or exchange. The team treasury claims it (SPV) and funds every agent by itself. This is the only human step, and it happens before the agents start.
4. `npm run preflight` (expect the donor-agent check to say autopilot rather than co-pilot).

> **Not yet run live:** `agents:mainnet` and `agents:fund` are unit-tested (plan, funding, deposits) and every part they start is tested. The launcher itself has not been run on a network yet. Do a testnet pass first (`NETWORK=test npm run agents:mainnet`).

| Time | Show | Say |
|---|---|---|
| **0:00–0:15** · Problem | Home page | "Crowdfunding hands creators a lump sum, and an AI agent with a budget can't be trusted with a blank cheque. Here, nobody clicks anything: agents raise, give, check and vote, on BSV mainnet." |
| **0:15–0:40** · The agent launches | Its campaign page: the terms built from one spending plan (5 readings × 50 sats + fees, 1,200 sats), its published limits, the anchor on WhatsOnChain | "This AI agent launched its own campaign. Every number in its terms comes from one spending plan, anchored on chain." |
| **0:40–1:05** · Donor agents decide | The live feed: 3 pledges arrive by themselves; one donor agent's memo (SPV anchor, published limits, score) | "Three donor agents, each with its own budget, read the terms, check them on chain, and pledge, or don't. No human approves." |
| **1:05–1:35** · Work, report, vote | Agent terminal: release → `paid 50 sats` × 5 → report anchored; the donor agents' YES votes with their reasons ("6/6 payments verified on chain") | "The agent buys real air-quality readings, 50 sats per call, and anchors its report. The donor agents verify every payment on chain before voting." |
| **1:35–2:05** · To the end | The campaign completes: 3/3 milestones; the agent's ledger | "Milestone by milestone, the money moves only after verified work. Zero clicks." |
| **2:05–2:30** · Other chains | The pre-recorded `npm run demo:bridge:ln` (captioned **local test network**) | "And donors don't need BSV: a liquidity agent swaps USDC, Bitcoin or Lightning into sats, atomically." |

**Must not claim:** the same as above, and that the run was unattended if anyone intervened.


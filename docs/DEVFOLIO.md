# Devfolio: paste-ready

Copy each block into the matching Devfolio field. Background and proof are in [`SUBMISSION.md`](SUBMISSION.md).

---

## Project name

```
CryptoPledgePot
```

## Tagline

```
Crowdfunding where AI agents raise, give and vote, and money moves only after verified work, on BSV.
```

## The problem it solves *

```
Crowdfunding hands creators a lump sum, and backers lose all leverage the moment they pay. An AI agent that needs a budget is worse: nobody can give it a blank cheque.

CryptoPledgePot puts every pledge into its own sCrypt escrow contract on BSV. The creator gets the money one milestone at a time, after posting a report that is hashed on chain and winning a pledge-weighted donor vote. If a campaign fails, donors take their sats back by themselves, even without our server.

Agents work on both sides:
- A fundraising AI agent raises its own budget and pays 50 sats per API call under spending limits enforced in code and published in its on-chain terms.
- Donor agents (co-pilot or autopilot) check every claim on chain (anchors by SPV, the agent's ledger against its limits, each report against its anchor) before they pledge or vote. Text that tries to manipulate AI agents scores 0.
- A liquidity agent brings in USDC, Bitcoin or Lightning through atomic swaps, with no custodian.

On BSV mainnet, a whole run worked with nobody clicking: one deposit funded the agents, the AI agent launched its campaign, donor agents decided and pledged, and when the goal was missed they reclaimed their pledges automatically.
```

## Challenges we ran into *

```
- The model decides, code controls the money. Claude chooses what to buy and how good a campaign is; every amount, cap and rule is in code. Testing with real Claude caught real bugs: the donor prompt read 50,000 sats as $50,000, reports were judged against the wrong milestone, and the agent's own terms contradicted themselves (it raised far more than its spending cap). The fix was to derive every term from one spending plan.
- Unattended operation. With nobody watching, agent wallets would have stopped after ~12 chained payments because no wallet monitor recorded merkle proofs. We found it in an offline rehearsal and fixed it before mainnet.
- Honest scoring. A careful model always lists concerns; our first scoring rule meant no new campaign could ever be funded. We rehearsed until the numbers made sense.
- Atomic swaps across very different chains, all locked to the same sha256 secret with no custodian: a Solidity HTLC (checked against real USDC and Uniswap on a Base fork), a P2WSH script on Bitcoin Core, and Lightning hold invoices on LND.
- Keeping it non-custodial: users' keys never leave their own BRC-100 wallet; a personal donor agent is never exposed to the internet.
```

## Technologies used *

Tags to add:

```
BSV, sCrypt, TypeScript, Node.js, React, Vite, Express, SQLite, Claude, Anthropic API, BRC-100, wallet-toolbox, @bsv/sdk, HTTP 402, Solidity, viem, Bitcoin Core, Lightning (LND), Docker, Podman, Caddy, ngrok, Vitest, Slither
```

## Tracks

```
BSV: DeFi Rails for Agentic Payments
```

Add up to two more, if your hackathon lists AI or agents tracks that fit.

## Links for judges

| Field | What to put | Status |
|---|---|---|
| Demo video (≤ 2.5 min) | The upload URL | **You:** record it with `VIDEO_SCRIPT.md` |
| GitHub repository | The public repo URL | **You:** push it; run `SUBMISSION.md` §6 first |
| Live demo | `https://<your ngrok domain>` while your Docker stack runs (`DEMO_RUNBOOK.md` §2b) | Ready when you start it |
| Extra proof | The WhatsOnChain links below | Ready |

## Proof (paste into the description or the "extra proof" field)

```
BSV mainnet, zero-click run (only agents; one human deposit):
- The team's deposit, claimed by the treasury after an SPV check: https://whatsonchain.com/tx/61f4ba9d5e19fb98c25eb2810b7e9cfb56a04fccf4be52dd4fd373b8ef7e8960
- Treasury → fundraising AI agent: https://whatsonchain.com/tx/8f15a1870c6aee7fbee2206cdaf724db3b3484b6b296b24d0657bf126569b9b2
- The AI agent's own campaign, anchored on chain: https://whatsonchain.com/tx/2c50c4dd0a5b56a509c393bd1d16314eeee050ac4a3e391c90caf6e50616f19c
- Donor agents' pledges into escrow: https://whatsonchain.com/tx/b15f46d76ce5a00fa96ca82ea8f8e267dd0362e63d568692b6bf75fd9c6431d6 · https://whatsonchain.com/tx/079f8ecf67bad7cf85db3d4cbad0a4ca16e344948d1fe729abfe9c419dad1238
- Goal missed → donor agents reclaimed automatically: https://whatsonchain.com/tx/baa6a94b811f99ed258d2b0b0a64124b1364aa223bc409832694cabc3a9d2b2d · https://whatsonchain.com/tx/0dfda8d42d1d3fe3081da25e8c4620bbd9e026f6c43f96bdf0592e1f7167ecc0
```

**Still missing: the AI agent paying per call, end to end, on mainnet** (SubmissionTODO: "Demo shows the AI agent's payment end to end"). The quickest way to get it is with your running Docker stack:
1. On the AI agent's status page, click **Top up agent fees** (~3,000 sats). The agent launches its campaign: goal 1,200 sats, deadline 15 minutes.
2. Fund it to the goal: you and your teammates donate from BSV Desktop, or approve your donor agent's proposal.
3. After the deadline, the agent releases milestone 1 by itself and buys 5 readings at 50 sats each.

Each payment appears with a WhatsOnChain link in the campaign's "Every payment it made" list. Record it: it's also the core of the video. Add those links above.

## Media

- **Cover:** `docs/screenshots/cover.png`
- **Screenshots:** `01-home.png`, `02-agent-campaign.png` (the AI agent's terms, report and every payment), `03-completed-campaign.png`, `04-failed-campaign.png`

## Builders

Make sure every teammate is added on Devfolio: Farhan, Finja, Louisa.

# CryptoPledgePot: demo video script (2–3 minutes)

Record either **mainnet** (preferred; the track wants real transactions) or
**"AirWatch live"** (`npm run demo:agent` + `npm run app`, or the Docker
`agent-demo` profile) if sats aren't available yet. AirWatch plays the whole
agent story by itself in ~1½ minutes (`DEMO_PACE_S=6`): just narrate while the
banner advances. Say which one you're showing.

**Before recording (mainnet):** start `npm run server`,
`npm run data-provider`, `npm run agent` and `npm run app`. Top up the agent
(~3,000 sats) and let it launch its campaign. Keep the agent's terminal visible
next to the browser. Have two BSV Desktop wallets with a few thousand sats
each.

---

**0:00 – 0:20 · The problem**
> "Crowdfunding platforms hold your money, take up to 8%, and once they pay out
> you have no leverage. And the new kind of creator, an AI agent that needs a
> budget to buy data and APIs, can't be trusted with a lump sum at all. CryptoPledgePot
> fixes both on the BSV Blockchain."

*Show the home page with the tabs.*

**0:20 – 0:50 · Backing a campaign**
> "This campaign wasn't launched by a person. It was launched by an AI agent.
> Its mission: buy air-quality data and publish open reports."

*Open the AirWatch campaign: AI agent badge, description, milestones.*

> "I donate from BSV Desktop. My sats don't go to the agent; they go into an
> sCrypt escrow contract. One approval, a fraction of a cent in fees, and my
> message is written on chain."

*Click Donate, approve in BSV Desktop, and show the donation appearing in the
live feed. Open its WhatsOnChain link.*

**0:50 – 1:30 · The agent gets paid, and pays**
> "Once the goal is met, the agent can withdraw only milestone one: 40%. The
> contract re-locks the other 60%."

*Agent terminal: `released milestone 1: … sats → agent wallet`.*

> "Now it works. Claude decides which cities to buy data for, and code decides
> how much: it reads the price from the HTTP 402 response, refuses anything
> over its cap or from an unknown host, and pays 50 sats per call."

*Agent terminal: the `paid 50 sats for munich … tx …` lines. In the browser,
the agent panel's "Every payment it made" list fills up; click one txid →
WhatsOnChain.*

**1:30 – 2:05 · Backers stay in control**
> "The agent posts its report, with a link to every payment, as the update
> for milestone two. Backers vote, weighted by what they pledged. The next
> tranche is released only if the majority says yes."

*Show the report on milestone 2 and the vote bar. Click Approve from a backer
wallet. The agent terminal shows the milestone 2 release on its next step.*

> "And if a campaign fails, or the agent stops delivering, backers reclaim what
> is still in escrow, after the refund date even without CryptoPledgePot's help.
> Nobody, not us and not the agent, can take donors' money alone."

*Dashboard → a pledge → Reclaim (offline demo: the missed-goal campaign).*

**2:05 – 2:30 · Why it matters for BSV**
> "Every donation, release, refund and API call is a real BSV transaction
> costing a fraction of a cent. Only BSV makes this economical. It's built on
> the official stack: the SDK, wallet-toolbox, BSV Desktop, BRC-29 payments,
> BRC-121 pay-per-call and Arcade. There are 88 automated tests, and the
> contract is cross-checked byte for byte against the sCrypt compiler."

*End on the README's mainnet transaction links.*

---

**Transactions to capture for the submission** (add them to
`docs/USAGE_AND_VALUE.md`):
- the campaign anchor;
- a donation;
- the milestone 1 release;
- 2–3 of the agent's API payments;
- the milestone 2 release;
- a refund.

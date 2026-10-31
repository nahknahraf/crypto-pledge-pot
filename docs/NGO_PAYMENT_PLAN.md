# NGO payment plan and the compliance agent

Donors should know **before** they give how an NGO will spend each milestone,
and the NGO should be held to it after the money is released.

## 1. The payment plan (signed before launch)

For every milestone the NGO lists its budget lines: a category, a payee, and
the line's share of the milestone's money. It also accepts the rules:

| Rule | Default | Meaning |
|---|---|---|
| `tolerancePercent` | 10 | each line may deviate at most this much from its planned amount |
| `reportDays` | 30 | days after a release to spend and report every line |
| `graceDays` | 7 | days to fix a breach, or pay the unaccounted sats back |
| `auditorKey` | — | identity key whose signature makes an off-chain (fiat) invoice count |
| `legalTerms` | `defaultLegalTerms()` | purpose-bound donation under condition (§§ 525, 527 BGB) |

The NGO's wallet signs the plan (`PAYMENT_PLAN_PROTOCOL`, keyID = campaign
nonce, counterparty `anyone`, so anyone can verify it). The plan and the
signature are part of the campaign JSON, so the plan is fixed into the
campaign id, the on-chain anchor and every donor's escrow. The server refuses
a campaign whose plan signature does not verify.

Lines are **shares**, not amounts: if a campaign raises more than its goal, the
plan scales with it.

## 2. Proving the spending

| Payee | How the NGO proves it | What is checked |
|---|---|---|
| `onchain` (vendor address) | `payPlanLine()` pays from its wallet and posts the AtomicBEEF | SPV, and the output pays exactly the payee's script; each output counts once |
| `offchain` (paid in fiat) | `reportSpending()` with the invoice sha256 and the auditor's signature | the auditor named in the plan signed `auditMessage(campaign, milestone, line, sats, invoice)` |

`evaluateSpending()` gives, per line, the planned and the spent amount and the
deviation `|spent − planned| / planned`. The milestone is compliant when every
line is within the tolerance. Otherwise the **unaccounted** amount is
`released − Σ min(spent, planned × 1.1)`.

## 3. The timeline (`core/compliance.ts`)

```
release ──30 days──▶ report date ──7 days──▶ end of grace
reporting            compliant ✓              cured ✓ · repaid ✓ · breached ✗
                     or grace starts
```

- **Releases are gated.** The arbiter co-signs milestone k+1 only when milestone
  k is `compliant`, `cured` or `repaid`, and the donors voted YES as before.
- **Repayment** goes straight to the donors: one transaction with a P2PKH
  output to each pledge's donor key, pro rata to what that pledge put into
  the milestone. Paying one donor more does not cover another. Donors collect
  it with `claimRepayments()` (their autopilot agent does it automatically).
- **Breach**: the campaign status becomes `breached`, no further milestone is
  released, and the arbiter co-signs early refunds of every remaining escrow.

The state is a pure function of the data and the clock, so the arbiter, the
agent and any donor reach the same verdict.

## 4. The compliance agent (`npm run compliance`)

The arbiter enforces the rules even if the agent is down. The agent acts on time:

- when a milestone is released it tells the NGO what to spend, on which lines, by when;
- it reminds the NGO 3 days before the report date and before the grace period ends;
- it opens the grace period publicly, saying what is missing and what must be paid back;
- at a breach it writes a permanent `breach` OP_RETURN record (with a funded
  wallet) and tells the donors to reclaim their escrow.

Notices are served at `GET /api/compliance` and can be pushed to a webhook
(`COMPLIANCE_NOTIFY_URL`). The donor agent counts a breached campaign as a
failure in the creator's record, votes NO on more money for an NGO that has
not accounted for the last tranche, and reclaims escrow from breached campaigns.

## 5. What the chain can and cannot enforce

- Money **still in escrow** is protected by the contract: a breach makes it
  refundable at once, and after `refundAfter` donors reclaim it alone anyway.
- Money **already released** is in the NGO's wallet. No script can pull it
  back. What this design adds is a 7-day window to repay on chain, a public,
  permanent breach record, a worse track record for the NGO with every donor
  agent, and the signed legal terms as the basis for a claim.
- A plan fixes payees and shares, not the quality of the goods. Deliverables
  are still judged by the donor vote and the progress reports.

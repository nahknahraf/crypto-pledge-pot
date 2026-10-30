# CryptoPledgePot: use cases for agents

CryptoPledgePot gives agents a safe way to **raise** money and a safe way to **give**
it:
- funds sit in milestone escrow, not with the recipient;
- every spend can be a traceable micropayment;
- backers vote with their pledged sats;
- money in failed campaigns can be reclaimed without asking anyone.

Below are 20 concrete scenarios: 10 where an NGO's agent raises money for
something very specific, and 10 where an individual's agent finds causes and
does the due diligence for them.

**What already exists vs. what's new.** Part A runs on today's code; each NGO
needs a real pay-per-call service for its domain, with the demo's air-quality
shop as the template. Part B needs the **donor agent**, see
[`DONOR_AGENT_PLAN.md`](DONOR_AGENT_PLAN.md).

---

## A. NGOs whose agent raises money for something very specific

How it works for every row:
1. The NGO's agent launches a campaign with measurable milestones.
2. Backers pledge into escrow.
3. The agent withdraws one milestone at a time and spends it on pay-per-call
   services, each payment capped and logged.
4. It publishes a report with a link to every payment; backers vote before the
   next tranche.

| # | NGO and specific goal | Milestones | What the agent pays per call | Why escrow matters to backers |
|---|---|---|---|---|
| A1 | **River-cleanup NGO**: test 40 sampling points on one river for microplastics before and after a cleanup | Baseline lab analyses → cleanup → re-test | Lab-result API per sample; satellite turbidity images per tile | The last tranche is released only once the re-tests are published, so donors see whether the cleanup worked |
| A2 | **Wildlife trust**: track 12 collared elephants through one drought season | Collars activated → 3 months of positions → corridor report | GPS fixes per position via a satellite messaging API | Donors pay for data that actually arrives; if collars go silent, the rest is reclaimable |
| A3 | **Rural health clinic**: translate a malaria-prevention leaflet into 8 local languages and record it as audio | Translations → native-speaker review → audio files | Translation and text-to-speech per paragraph; reviewer bounties | Each language is visible before the next tranche; no lump sum to an intermediary |
| A4 | **Food bank**: price-match staple foods across 30 wholesalers every week for one winter | Supplier data → 8 weekly purchase plans → savings report | Wholesale price-feed calls per product | Backers vote on the savings achieved before funding more weeks |
| A5 | **Open-science NGO**: replicate one published study's statistics | Data access → reanalysis → published result | Compute per job; dataset licences per file | Funds come back if the dataset can't be obtained by the deadline |
| A6 | **Disaster-response NGO**: damage map for one flooded district within 72 hours | Imagery bought → map published → field verification | Satellite scenes per km²; geocoding per address | Fast funding without a blank cheque: the first tranche covers imagery only |
| A7 | **Literacy charity**: reading-level assessments for 500 children in 10 schools | Assessments → tailored book lists → 3-month re-test | Assessment scoring per child; book-catalogue lookups | Backers see the improvement before the book budget is released |
| A8 | **Urban tree NGO**: plant 1,000 trees and prove 80% survive one year | Planting with geotags → 6-month check → 12-month check | Tree-health imagery per geotag; weather data | The last 40% is released only if survival is proven; otherwise donors reclaim it |
| A9 | **Legal-aid NGO**: research precedents for 25 tenant-eviction cases | Case intake → research memos → outcomes summary | Legal-database queries per search; court-record fetches | Per-query receipts show the money went to research, not overhead |
| A10 | **Accessibility NGO**: audit 200 public websites for accessibility and file fix requests | Audits → reports sent → re-audit after 60 days | Automated audit runs per page; screen-reader testing per site | Donors fund outcomes (the re-audit), not promises |

---

## B. Individuals whose agent finds causes and does the due diligence

How it works for every row:
1. The donor gives the agent a **mandate** (what to support, budget, limits,
   when to ask first).
2. The agent screens campaigns, pledges within the budget, and follows each one
   through every milestone.
3. It checks the evidence in reports, votes, and reclaims money from campaigns
   that fail.
4. It explains every decision to the donor in plain language.

| # | The donor's mandate | Checks before pledging | During the campaign | When it votes no or reclaims |
|---|---|---|---|---|
| B1 | "€20 a month to **clean-water projects in East Africa**; nothing from creators who haven't delivered before" | Creator's past campaigns (completed vs. refunded); is the arbiter known; are the milestones measurable | Checks that each report's lab-result links resolve and match | A report has no verifiable evidence → votes no; the campaign fails → reclaims at once |
| B2 | "Back the **open-source maintainers whose software I use**" | Matches campaigns to the projects you depend on; is the creator linked to the project | Checks the releases promised per milestone exist (tags, changelogs) | A milestone claims a release that doesn't exist |
| B3 | "**Spread $50 across 25 micro-pledges** to new creators" | Minimum checks per campaign: valid anchor, sensible refund date, realistic goal for the milestones | Tracks all 25 escrows; one weekly summary for you | Reclaims each one after its refund date if nothing was released |
| B4 | "Fund **AI agent services that publish open data**" | Is the agent's status page live; are its past payments real and on chain; is its price cap sensible | Compares its spending ledger with its report: calls paid vs. results delivered | It spent outside its stated mission, or paid above its stated cap |
| B5 | "**Disaster relief, but only in the first 72 hours**" | Location matches the affected area; the first tranche is small; arbiter and creator are known | Checks the imagery or map promised in milestone 1 actually appears | Nothing arrives within 72 hours: reclaims |
| B6 | "Give to **animal shelters near me**" | Distance; is the shelter registered (via a paid registry lookup) | Checks adoption numbers in each report against public listings | The numbers don't match |
| B7 | "**Climate projects with measurable CO₂ outcomes**" | Is there a measurement method in the milestones; is its data source auditable | Re-runs the measurement itself through the same data service | Its own measurement disagrees with the report by more than a set margin |
| B8 | "**Research by students at my old university**, at most 5 at a time" | Supervisor or department named; no more than 5 active pledges | Watches for the papers or posters promised per milestone | A milestone date passes without the promised output |
| B9 | "**Never more than 10% to any one creator**" | Checks the whole portfolio before every new pledge | Steers new pledges toward under-funded causes | Doesn't vote differently; simply declines new pledges to an over-concentrated creator |
| B10 | "**Explain every decision to me**, and ask before any NO vote over €5" | Writes a short memo per campaign: why it pledged, what could go wrong | Monthly digest: released, spent, voted, with links | Asks you first before any NO vote above your threshold |

---

## What makes these trustworthy

- **Nobody holds the money but the contract.** Escrow releases need the
  creator *and* the arbiter, one tranche at a time; donors can always reclaim
  after the refund date.
- **Every spend is a receipt.** Agent payments are BSV micropayments with
  txids in the agent's ledger and reports.
- **Limits are code, not promises.** Agents work with allow-lists, price
  caps, budgets and reserves that the language model cannot override.
- **Votes are weighted by money at stake,** so a tiny backer can't block a
  milestone, and a large one is accountable on chain.

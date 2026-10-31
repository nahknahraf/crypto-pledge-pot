# Plan: make the fundraising agent count, for the judges and the qualification gate

*30 October 2026 · written against the BSV track rules (TBC26 BSV Track
Requirements PDF) and the current code · status: plan*

**The fundraising agent** (`fundraising-agent/`, "AirWatch") is an AI service that:
- raises its own budget in CryptoPledgePot milestone escrow;
- withdraws one approved milestone at a time into its own wallet;
- pays a data API per call with BSV micropayments (BRC-121), refusing
  overpriced or unknown sellers;
- reports with a link to every payment, so backers can vote on the next
  tranche.

This plan says what to do so that it **passes the qualification gate** and
**scores as high as possible** on each judging criterion, and how we'll measure
that it works.

---

## 1. Where it stands today (honest)

| | Status |
|---|---|
| Works end to end offline | ✅ real wallets on the mock chain; 9 e2e tests; the "AirWatch live" demo (16 beats) |
| Safety | ✅ allow-list, price cap, per-milestone budget, fee reserve; refuses the 500-sat "premium" call |
| Visible reasoning | ✅ activity log and spending ledger on the agent panel |
| **Mainnet** | ❌ **never run** (start-up smoke-tested; stops at "insufficient funds") |
| **Claude brain** | ❌ **never called live** (scripted-client tests only); demos use the mock brain |
| Data | ⚠️ **synthetic** air-quality readings (`synthetic: true`) |
| Public URL | ⚠️ ngrok was pointing at port 80 (redirect loop); fixed in Compose, but the user's ngrok must point at **8081** |
| What judges see on `master` | ⚠️ donor agent and swaps live on unmerged branches (`donor-agent` +4, `cross-chain-swap` +7 commits) |
| Submission docs | ⚠️ usage note says 88 tests (now 142); **no video; no transaction links** |

## 2. The qualification gate (must all pass)

| Requirement (PDF §3) | What to do | Evidence for the submission | Priority |
|---|---|---|---|
| BSV SDK + Wallet Toolbox | ✅ already: the agent's wallet is wallet-toolbox; everything uses `@bsv/sdk` | README "stack" table (§6 below) | done |
| User flows with BSV wallets | ✅ donate, vote and top-up from BSV Desktop; **re-confirm on mainnet** in run R1 | 2 donation txids from BSV Desktop | P0 |
| Real transactions on BSV | **Run R1 on mainnet** (§3) | WhatsOnChain links: launch anchor, ≥2 donations, milestone release, **≥2 agent API payments**, a vote, a refund | **P0** |
| Non-custodial | ✅ escrow (creator + arbiter, tranche by tranche, donor self-refund); the agent only ever holds released tranches | The trust-model paragraph; one refund txid | P0 |
| **An AI agent makes a payment** | **R1**: the agent pays the data API per call **on mainnet, with the Claude brain choosing what to buy** | ≥2 agent payment txids + the agent panel screenshot + the agent's log line showing Claude's plan | **P0** |
| README, demo video, tx links, usage note | Refresh the README and usage note; **record the 2–3 min video** (`docs/DEMO_SCRIPT.md`); add the link table | Video URL; link table in `USAGE_AND_VALUE.md` | **P0** |

**R1 is the single most important task:** without it, the agentic-payment
and real-transaction requirements are unmet.

## 3. Run R1: the agent on mainnet (about 2–3 hours, two people)

Pre-flight:
1. Team sats in BSV Desktop (two wallets, a few thousand sats each).
2. `ANTHROPIC_API_KEY` set on the host. Confirm the brain says
   `claude:claude-opus-5-5` at start-up.
3. The public URL works: ngrok to **8081** (Compose) or `npm run share:internet`.
   Check `/api/health` from outside.
4. Small, fast terms: goal ~5,000 sats, deadline 15–20 min, 2 milestones
   (40/60), price cap 50, per-milestone spend ≤ 500.

The run:
1. Start the server, data API and agent. **Top up the agent** (~3,000
   sats, BRC-29 from BSV Desktop). It launches its campaign (anchor txid).
2. Two teammates pledge from BSV Desktop (donation txids, live feed visible
   on a third device).
3. Deadline → the agent withdraws milestone 1 (release txid).
4. **Claude plans the purchases; the agent pays per call** (payment txids,
   ledger, report with links).
5. Teammates vote; the agent withdraws milestone 2 and buys again.
6. A second, deliberately failing campaign → a backer reclaims (refund txid).
7. Record everything: txids → `USAGE_AND_VALUE.md`; screenshots; the video.

Exit: every row in §2 has a mainnet link; the agent panel shows Claude's plan
and at least 2 receipted payments.

## 4. Raising the score, criterion by criterion

### Adoption potential and real-world usefulness (35%)
| Action | Why judges care | Effort |
|---|---|---|
| **A1. Real data instead of synthetic:** the data provider resells real readings from a free public source (e.g. OpenAQ), still paid per call over BRC-121, with the source credited | "An app people would actually use" needs real output; the reports become genuinely useful open data | 2–3 h |
| **A2. "Launch your own agent service" template:** mission, milestones, price cap, data source in one config file + `npm run agent -- --init` | Shows NGOs and indie developers can reuse it (USE_CASES A1–A10), not just one demo | 2 h |
| **A3. Donors from other chains:** merge the swap work; show "Fay has only USDC" backing AirWatch | Directly the track's "users and liquidity from other chains"; be honest that the USDC side is simulated in this version | merge only |
| **A4. Agents funding agents:** merge the donor agent; in the demo, a donor agent (co-pilot) proposes AirWatch and its owner approves | A distinctive two-sided agent economy, both sides non-custodial | merge + 1 h demo beat |
| A5. Publish each report as a public page with its txid list (shareable link) | Gives backers something to share, which brings new users | 1 h |

### Use of the BSV stack (25%)
| Action | Effort |
|---|---|
| **S1. A stack table in the README:** per feature, which BRC/package (BRC-100 wallets, BRC-42 keys, BRC-29 top-ups, BRC-121 pay-per-call, BRC-103/104 auth, BEEF/SPV, Arcade headers, wallet-toolbox in 4 roles, sCrypt covenant, OP_RETURN records) | 30 min |
| **S2. Anchor each agent report on chain:** OP_RETURN with the report hash + milestone, so a report can't be rewritten later; the donor agent verifies it | 1–2 h |
| S3. Show mainnet txids per stack feature in the usage note (from R1) | in R1 |

### Technical execution, incl. non-custodial design (20%)
| Action | Effort |
|---|---|
| **T1. Publish the agent's limits in its campaign** (price cap, per-milestone spend) so anyone, including donor agents, can audit its ledger against them. This closes the donor agent's "payments ≤ stated cap" check | 1 h |
| T2. Agent resilience: resume after restart mid-milestone (state is persisted; add a test), and retry a failed payment once | 1–2 h |
| T3. One merged `master` with all branches, CI-style check (`npm test`, both type-checks, build) green | 1 h |
| T4. A short "threat model" section: what the agent can and cannot do with money, what backers can always do | 30 min |

### Agentic payments (10%)
| Action | Effort |
|---|---|
| **P1. R1 on mainnet with the Claude brain** (the gate item); keep its plan text in the activity log | in R1 |
| P2. Show a refusal on mainnet (a premium-priced reading above the cap) | in R1 |
| P3. Optional: the agent pays a second kind of service (e.g. a translation or summary API per call) to show it's general | 2 h |

### Originality and presentation (10%)
| Action | Effort |
|---|---|
| **O1. The 2–3 minute video:** "AirWatch live" (offline) as the backbone, intercut with the R1 mainnet links; a 20-second "Fay has only USDC" segment | 2 h |
| O2. A one-paragraph pitch at the top of the README ("Fund an AI agent without giving it a blank cheque") with the best screenshot | 20 min |
| O3. Clean demo hygiene: no placeholder text, consistent naming, current test counts | 30 min |

## 5. How we measure that the agent works (shown to judges)

| Metric | Target | Source |
|---|---|---|
| Spend receipted on chain | **100%** of the agent's spending has a txid | Ledger vs. WhatsOnChain |
| Overspend | **0**: never above the price cap or milestone budget | Ledger, tests |
| Cost efficiency | Fees per paid call < 1% of the call price at mainnet rates | R1 txids |
| Backer control | Every tranche after the first released only after a report and a majority vote | Campaign view |
| Recovery | A failed campaign is fully refundable; refund ≤ 1 tx per backer | R1 refund txid |
| Time to value | From funded to first paid data call ≤ one agent loop interval (20 s) | Agent log timestamps |

## 6. Order of work (it's 30 October; time is short)

| Order | Task | Time | Outcome |
|---|---|---|---|
| 1 | **T3: merge `donor-agent` and `cross-chain-swap` into `master`;** all checks green | 1 h | One codebase for judges |
| 2 | Fix the public URL (ngrok → 8081) and verify from outside | 15 min | Testers can reach it |
| 3 | **R1 mainnet run** with Claude (§3) | 2–3 h | Gate passed |
| 4 | Usage note + README refresh (S1, O2, O3), link table | 1 h | Submission docs |
| 5 | **Video** (O1) | 2 h | Gate passed |
| 6 | If time remains: A1 real data → T1 published limits → S2 report anchoring → A4 demo beat | 4–6 h | Higher adoption, stack and technical scores |

**Minimum to qualify:** steps 1–5, about 6–7 hours. Everything in step 6
raises the score but is optional.

## 7. Risks

| Risk | Mitigation |
|---|---|
| No team sats in time | Ask @lexamaison now; R1 needs only ~10,000 sats in total |
| Claude refuses or times out mid-run | The refusal fallback is on; the agent skips that round and retries; the mock brain is the last resort (and must be disclosed) |
| BRC-121 header size through ngrok or proxies | Our data API raises the limit; keep the agent and data API on the same host in R1 |
| Deadline timing (waiting for funding windows) | Short deadlines (15–20 min) in R1; rehearse once offline with `SKIP_TUNNEL=yes` |
| Merging branches breaks something | Merge in order (donor-agent, then cross-chain-swap), running the full suite after each |

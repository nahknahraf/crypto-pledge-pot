# CryptoPledgePot: self-evaluation against the track criteria

*30 October 2026 · BSV track "DeFi Rails for Agentic Payments" (TUM Blockchain
& AI Hackathon) · tested locally on the current `master`.*

This is meant to be a fair evaluation, not a pitch. Scores are our estimate of
how a judge would read the project **today**, with what it would take to move
each one.

---

## 1. How we tested

| # | Test | Result |
|---|---|---|
| 1 | Build health: `tsc`, `vite build`, sCrypt cross-check, full suite | ✅ clean; bundle 729 KB (220 KB gzip, heavy); contract byte-identical to the sCrypt compiler; **88/88 tests** (50 CryptoPledgePot + 38 starter kit) |
| 2 | Qualification checklist (below) | 4 of 6 met, 2 partly |
| 3 | UI flows (Playwright on the offline demo) | Tabs and counts correct; create form blocks milestone shares ≠ 100% with a clear message; failed campaigns hide Donate and show refunds; home loads in ~0.6 s; no console errors; all images have alt text. **Mobile is broken: the page is 627 px wide on a 390 px phone** |
| 4 | API security probes (12) | All correct: unauthenticated writes → 401; malformed BEEF, bad nonce → 400; unknown ids → 404; 30 MB body → 413 (as an HTML page, not JSON); the paid API refuses forged payment headers (402) |
| 5 | Live feed (SSE) | Pledge (with memo), release, update, vote and refund events all arrive 50–400 ms after the action. This had no automated test before |
| 6 | Cost | Donation 3,458 B / 346 sats; releasing 3 escrows 18,650 B / 1,866 sats (≈ 620 sats per escrow per milestone); agent API call 50 sats + fee |

### Incident during testing: a real mainnet donation was sent

The "donate without a wallet" UI test assumed no wallet was running. **BSV
Desktop was running** (ports 3321/2121) and approved the request without a
prompt (spending permission for `localhost:5174` had already been granted
earlier). The automated click therefore sent a **real 10,000-sat donation**
(`217be330e43a6f2970e7b6ad1191a5e7837f3a735b8de59ea9eafa8a25380778`) into an
escrow for an *offline demo* campaign.
- Its creator and arbiter keys existed only in the demo process, so only the
  donor's own timelocked refund can reclaim it, from **2027-01-28T14:58Z**.
  The escrow's terms were decoded from chain and are intact.
- Lessons:
  1. **Check for a live wallet before automating any UI that can call it.**
  2. The app should show its own amount confirmation before calling the
     wallet. When a wallet has auto-approval on, a single click spends.

The same trace confirmed the team's own **mainnet** campaign "Fund a  well"
(anchor `c13091938fe16b3949219ed04834efa99a19118dc4a49153a42393952eaaaa2c`)
and a 1,000-sat pledge (`0e6375174520819879585b8a2b68e8d0a7bb0ae6d04b2a23ea31930f1e69002d`,
self-refundable from 2027-01-12). These were made before the rename, with the
old `bitfund` key names. Their local index entry was deleted earlier (see
DEVLOG), and the renamed app can't sign for them without a legacy-names path.

---

## 2. Qualification requirements (pass/fail gate)

| Requirement | Status | Evidence |
|---|---|---|
| BSV TypeScript SDK + Wallet Toolbox | ✅ | `@bsv/sdk` throughout. wallet-toolbox for the arbiter, the agent and the data provider |
| User flows connected to BSV wallets | ✅ | BSV Desktop via `WalletClient('auto')`. **Proven on mainnet**: campaign launch and donation above |
| Real transactions on BSV | ⚠️ partly | Mainnet: campaign anchor + 2 escrow pledges. **Not yet:** a milestone release, a refund, or an agent API payment on mainnet; no links in `USAGE_AND_VALUE.md` yet |
| Non-custodial, no single party holds users' assets | ✅ | sCrypt escrow: releases need creator + arbiter; donors can always self-refund after the refund date |
| At least one AI agent making a payment | ⚠️ partly | The agent is built and tested offline (real wallet-toolbox wallets, real BRC-121 payments on the mock chain). **Not yet run on mainnet.** The Claude brain has only been tested with a scripted client |
| README, demo video, tx links, usage/value note | ⚠️ | README ✅, usage/value note ✅, demo script ✅. **Video ❌, tx links ❌** |

**Today the project would most likely not pass the gate:** the agent's
payment, the video and the links are missing. All three are achievable in an
afternoon with the team's sats.

---

## 3. Rubric scores

| Criterion | Weight | Score | Why |
|---|---|---|---|
| Adoption potential and real-world usefulness | 35 | **17** | Clear problem (custodial, high-fee crowdfunding with no accountability) and a clear story for agents ("fund an AI without a blank cheque"). But on-chain crowdfunding is a crowded idea; users need BSV and a BSV wallet first; it raises only BSV (**no stablecoins, no liquidity from other chains**, which the track explicitly values); and the agent's data is synthetic. Mobile layout is broken, and most donors would come from phones |
| Use of the BSV stack | 25 | **20** | Broad and correct use: BRC-100 wallets, BRC-42 derived keys, BRC-29 payments, BRC-103/104 AuthFetch, BRC-121 HTTP 402, BEEF/SPV, Arcade, baskets, OP_RETURN, wallet-toolbox in three roles, and a real sCrypt covenant driven entirely by standard wallets. Held back by few mainnet transactions (no release, refund or agent payment yet) |
| Technical execution, incl. non-custodial design | 20 | **15** | Strong: escrow cross-checked byte for byte against the compiler; every spending path executed by the script interpreter; 50 project tests with exact sat accounting; spending limits enforced in code. Weaknesses below |
| Agentic payments | 10 | **5** | The flow is genuinely built (agent raises its budget → releases → pays per call → reports → vote) with good safety design, but it is offline-only and the LLM has never made a live call |
| Originality and presentation | 10 | **6** | The "escrowed agent budget" angle is original, and the UI and docs are polished. No video yet; the logo and look are generic |
| **Total** | **100** | **≈ 63** | |

**Achievable today, roughly 75–78:**
- agent run on mainnet with links (+3 agentic, +2 stack);
- video (+2 presentation);
- mobile fix and a confirmation step (+2 adoption, +1 technical).

Going beyond that needs stablecoin or cross-chain funding, a roadmap item too
big for this hackathon.

### Technical weaknesses found
1. **The index isn't rebuildable from the chain.** Losing `data/*.db` loses
   campaigns. This actually happened today. Campaign anchors and memos are on
   chain, but there's no re-indexer.
2. **The index can go stale.** Spends are indexed only when someone reports
   them (`/api/spends`); there's no chain watcher. Reported transactions are
   SPV-valid but are not checked as broadcast.
3. **No legacy-protocol path.** Pledges made under the old `bitfund` key names
   can't be released or refunded by the renamed app.
4. **A single arbiter key.** It can't take funds, but a colluding creator and
   arbiter could release tranches early.
5. **BRC-121 payment headers reach 35 KB at 0-conf.** We raised the limit on
   our API, but third-party paid APIs and proxies (nginx default 8 KB) would
   reject them.
6. **Escrows are expensive in bytes** (2.9 KB script; ≈ 620 sats per release
   per escrow). Fine at today's prices, but the contract's sCrypt stack
   overhead is visible.
7. **Minor:** the 413 error comes back as HTML; the bundle is 729 KB; there's
   no in-app confirmation before the wallet is called.

---

## 4. What to do next, in priority order

1. **Run the agent on mainnet:** top it up, back it, let it release and pay. Then
   add the WhatsOnChain links (launch, donation, release, ≥2 agent payments,
   refund) to `USAGE_AND_VALUE.md`. *This is the gate.*
2. **Record the 2–3 minute video** from `docs/DEMO_SCRIPT.md`.
3. **One live Claude run** for the agent's brain (set `ANTHROPIC_API_KEY`).
4. **Fix mobile** (627 px on a 390 px screen) and **add an in-app "Donate X
   sats?" confirmation**.
5. **A chain re-indexer** (rebuild campaigns and pledges from OP_RETURN
   records) and a **legacy `bitfund` key-name path**. This recovers "Fund a
   well" and lets its pledge be refunded or released.
6. **A refund tool** for any escrow, given its outpoint (terms can be read
   from chain). This covers the 10,000-sat test donation from 2027-01-28.

---

## 5. Follow-up: fixes made after this evaluation (same day)

| Finding | Status |
|---|---|
| Offline demo could reach a real wallet (the incident) | ✅ Fixed: the server reports its network; in `mock` the app never contacts a wallet; mismatched networks are refused |
| No in-app confirmation before payments | ✅ Fixed for donate, launch, withdraw, reclaim and agent top-up |
| Mobile: 627 px on a 390 px phone | ✅ Fixed: every page measures 390 px |
| 413 returned as HTML | ✅ JSON (plus JSON for malformed bodies) |
| Index not rebuildable from chain | ✅ `POST /api/import` + `npm run import`; "Fund a well" restored from mainnet |
| No legacy `bitfund` key path | ✅ Per-campaign protocol tag; legacy release and refund tested |
| Orphaned escrow (10,000-sat test donation) | ✅ `reclaimEscrow(outpoint)` + Dashboard "Recover"; usable from 2027-01-28 |
| Index goes stale unless spends are reported | ✅ Chain watcher (WhatsOnChain), every 5 min; a mainnet round ran cleanly |
| Single arbiter key | ⏳ Unchanged (design limitation; M-of-N is roadmap) |
| BRC-121 header size for third-party APIs | ⏳ Unchanged (documented; a protocol-level issue) |
| Bundle size (729 KB) | ⏳ Unchanged |
| Gate items: mainnet agent run, video, tx links | ⏳ Need the team's sats, so still open |

Tests: 98 passing (60 CryptoPledgePot + 38 starter kit).

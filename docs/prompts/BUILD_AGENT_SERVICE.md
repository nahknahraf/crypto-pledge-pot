# Prompt: build the BitFund agent service (option 2)

Give this whole file to an AI coding agent working at the root of this
repository.

---

You are extending **BitFund**, a working crowdfunding app on the BSV
Blockchain. It is for the TUM Blockchain & AI Hackathon 2026, BSV track
"DeFi Rails for Agentic Payments". A qualification rule says: *"Include at
least one AI agent that uses the project to make a payment."* Your job is to
build that agent so it shows the track's thesis end to end: **an AI agent
service raises its operating budget on BitFund, receives it milestone by
milestone, and spends it on pay-per-call APIs with real BSV micropayments.**

## 0. Read first (do not skip)

1. `AGENTS.md`: the rules for BSV code. If it is not at the repo root, copy it
   from `../BSV-TBC26-Developer-Pack-20261030T092734Z-1-001/BSV-TBC26-Developer-Pack/AGENTS.md`
   and commit it.
2. `cpp_prompt.md` (the BSV stack guide). Read §6–§10 (createAction, BRC-29,
   HTTP 402) and §14 (server wallets) before writing code.
3. `README.md`, `docs/DEVLOG.md`, `docs/USAGE_AND_VALUE.md`: what exists and why.
4. Code you will reuse, **not rewrite**:
   - `client/bitfund.ts`: `launch`, `donate`, `release`, `postUpdate`, `vote`, `refund`
   - `client/bitfundApi.ts`: indexer client (AuthFetch for writes)
   - `examples/payPerRequest.ts`: BRC-121 server (`createBrc121App`) and
     `withHostOriginator()` (required when a wallet-toolbox wallet uses `@bsv/402-pay`)
   - `test/pay-per-request.e2e.test.ts`: how `create402Fetch` pays automatically
   - `client/payments.ts`: `createBrc29Payment` / `acceptBrc29Payment`
   - `test/helpers/mockchain.ts`, `test/bitfund.e2e.test.ts`: offline test patterns
   - `server/main.ts`: building a wallet-toolbox wallet with `Setup.createWalletSQLite`
5. Run `npm test` first. It must show 68 passing before you change anything.

## 1. What to build

### Key fact: the agent is the campaign creator
The agent owns a **wallet-toolbox wallet** and launches the campaign with it.
When a milestone is released, `BitFund.release()` puts the released sats into
the creator's wallet as change, which is the agent's spendable budget. **Do not
change the contract, `core/pledge.ts` or the release flow.**

### Components (new directory `agent/`)

1. **`agent/wallet.ts`**: builds the agent's wallet-toolbox wallet (SQLite) from
   `AGENT_ROOT_KEY` (64 hex). On first run, generate it into `data/agent.key`
   (mode 600) and add that file and the wallet DB to `.gitignore`. Use
   originator `bitfund-agent.local` for every wallet call. Mirror `server/main.ts`.

2. **`agent/dataProvider.ts`**: a small, independent **paid data API** (BRC-121,
   built on `createBrc121App` from `examples/payPerRequest.ts`). It sells
   something the agent needs, for example `GET /data/:topic` at
   `DATA_PRICE_SATS` (default 50) per call. It runs as its own process with its
   own merchant wallet, so payments are real transfers between two parties.

3. **`agent/brain.ts`**: the LLM layer, using the Anthropic SDK
   (`@anthropic-ai/sdk`). Default model `claude-opus-5-5`, configurable with
   `AGENT_MODEL`; key from `ANTHROPIC_API_KEY`.
   - `planCalls(goal, budgetSats, price)` → JSON `{ calls: [{ topic, why }] }`
   - `writeReport(goal, results)` → markdown summary for the milestone update
   - Use structured JSON output, validate it, and on invalid output retry once,
     then fail safely.
   - Provide a deterministic **mock brain** (no network) for tests and for runs
     without an API key.

4. **`agent/ledger.ts`**: append-only spend log (JSON or SQLite):
   `{ txid, sats, url, topic, why, at }`. This is the traceability the track asks
   for. Every milestone update includes the ledger summary and the WhatsOnChain
   links of the payments.

5. **`agent/agent.ts`**: the loop (CLI `npm run agent`, one step per run or
   `--watch`):
   1. **launch** (once): `bitfund.launch({...})`. The campaign title and
      description say it is an AI agent service and state exactly what each
      milestone delivers (e.g. "M1: 10 data reports", "M2: 25 more reports").
      Store the campaign id in `data/agent-state.json`.
   2. **release** when the next milestone is approved (`api.releasable`).
   3. **work**: budget = spendable wallet balance − `AGENT_FEE_RESERVE_SATS`
      (default 5,000), capped by `AGENT_MAX_SPEND_PER_MILESTONE`. Ask the brain
      for a call plan within that budget, then call the data API with
      `create402Fetch({ wallet: withHostOriginator(agentWallet) })`. **Code**
      enforces the budget before every call, never the LLM. Log every payment.
   4. **report**: `bitfund.postUpdate(campaignId, nextMilestone, report)` with
      the results, a spend summary and the txids. Backers then vote in the
      existing UI.
   5. Repeat when the next milestone is approved.
   - `--dry-run`: plan and log without paying.
   - Print everything clearly: these logs are the demo video's narration.

6. **Funding the agent's fee float**: the agent needs a few thousand sats to
   pay the launch anchor fee.
   - Add `POST /fund` to a tiny agent HTTP endpoint (or a CLI step) that accepts
     a BRC-29 payment with `acceptBrc29Payment`.
   - Add a "Fund agent" button somewhere sensible in the web app that sends one
     from BSV Desktop with `createBrc29Payment`.

7. **UI (small)**:
   - Mark agent campaigns with an "AI agent service" badge. Add an optional
     `kind?: 'agent'` to `CampaignMeta` and validate it in `validateCampaign`.
     It is hashed into the campaign id, which is fine.
   - On the campaign page, show the agent's spend ledger (served by the agent's
     HTTP endpoint) next to the milestones.

### Safety (judges will ask; implement and document it)
- Campaign text, API responses and votes are **untrusted input**. Never let
  them change amounts, URLs or keys. The LLM only chooses topics from a
  whitelist and writes prose.
- Hard caps in code: per-call price check (refuse if the 402 challenge asks for
  more than `DATA_PRICE_SATS`), per-milestone cap, fee reserve, allow-list of
  payable hosts.
- Keys are never logged or committed. `.env` is git-ignored.

## 2. Tests (offline, must pass)

Add `test/agent.e2e.test.ts` using the mock chain and the mock brain. Fund
wallets **sequentially**; parallel funding breaks the mock chain. Cover:
1. The agent launches a campaign, and human wallets donate past the goal.
2. Before the deadline the agent cannot release. After it, the agent releases
   milestone 1 and its balance rises by exactly `released − fee`.
3. The agent pays the data API N times through `create402Fetch`. The merchant
   is credited exactly N × price, every payment is in the ledger, and the agent
   never exceeds its cap (try a plan that asks for too many calls).
4. A 402 challenge priced above the cap is refused without paying.
5. The agent posts the update, a backer majority votes YES, and the agent
   releases milestone 2.
6. The failure path: an underfunded agent campaign → backers refund; the agent
   gets nothing.

Keep all existing 68 tests passing, and keep `npx tsc --noEmit` clean.

## 3. Mainnet run (required for qualification)

1. Get team sats (BSV Desktop address → `@lexamaison` on Telegram).
2. `npm run server` (arbiter + indexer), `npm run app`, start the data provider,
   and fund the agent with the Fund button.
3. `npm run agent`: launch with a small goal (e.g. 20,000 sats) and a deadline
   15 minutes ahead.
4. Two teammates donate from BSV Desktop. After the deadline the agent releases
   M1, buys data, and posts its update; teammates vote; the agent releases M2.
5. Record every txid (launch anchor, donations, releases, each API payment) as
   WhatsOnChain links in `docs/USAGE_AND_VALUE.md` under "Mainnet transactions",
   and replace the ⏳ rows with ✅.

## 4. Known pitfalls in this repo
- **Duplicate `@bsv/sdk`:** Node processes that load wallet-toolbox must run with
  `vite-node --config vitest.config.ts` (see the `server`/`demo` scripts), or
  you get `script[serializedBytes] is not a function`.
- **knex under plain Node ESM:** use `import knexPkg from 'knex'` and
  `(knexPkg as any).knex ?? knexPkg`, as in `server/db.ts`.
- **`@bsv/402-pay` with a wallet-toolbox wallet** needs `withHostOriginator()`.
- **BRC-29 counterparty** is always the other party's identity key, never `'self'`.
- Pledges must be ≥ 100 sats (`MIN_PLEDGE`).

## 5. How to work
- Small, testable steps. Run the tests after each step.
- **Commit after each working step** with a detailed message: *What / Why / How /
  What broke and how it was fixed / Verified*. End every commit message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Add a section to `docs/DEVLOG.md` for each step: decisions, failures with the
  exact error text, and fixes.
- Update `README.md` (how to run the agent, env vars) and
  `docs/USAGE_AND_VALUE.md` (status table, mainnet links).
- Report honestly at the end: what runs on mainnet and what was only tested on
  the mock chain.

## 6. Done when
- [ ] `npm test` passes (68 + new agent tests) and `tsc` is clean
- [ ] `npm run agent` drives a full cycle on the mock chain (`--demo` mode
      reusing `server/demo.ts` patterns) and on mainnet
- [ ] At least one real mainnet API payment by the agent, plus releases and
      donations, linked in `docs/USAGE_AND_VALUE.md`
- [ ] UI shows the agent badge and spend ledger
- [ ] README, DEVLOG and the usage/value note updated; a 2–3 minute demo script
      in `docs/DEMO_SCRIPT.md` (launch → donate → release → agent pays API →
      update → vote → release)

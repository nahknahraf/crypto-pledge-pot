# BitFund — engineering log

A running record of what was built, why, how, and what broke along the way.
Newest entries at the bottom. Commit hashes refer to this repository.

---

## 0. Starting point (2cfa735)

The repo began as the "BSV-21 token kit" from the BSV stack guide
(`cpp_prompt.md`, Appendix A): overlay, BRC-100 client, mock-chain tests.
Baseline: `npm test` → 38/38 passing, `tsc` clean. The kit is kept as is; it
is the reference for how the stack is used (wallet signing via
`createSignature({ hashToDirectlySign })`, mock chain, AuthFetch servers).

**Task** (from `cpp_prompt.md`): BitFund, a GoFundMe-style crowdfunding app on
BSV. sCrypt escrow, all-or-nothing goal, milestone releases approved by
multisig or a donor vote, refunds via script, OP_RETURN audit trail, wallet
donations, and a dashboard.

---

## 1. Escrow design decisions

### One escrow UTXO per donation (not one shared campaign UTXO)
- **Why:** with one stateful campaign UTXO, every donation has to spend the
  previous one, so donors queue behind each other, race, and retry. With one
  UTXO per donation, donations never conflict and can be made in parallel,
  which is the point of BSV micro-donations.
- **Cost:** a release spends many inputs, so they go in batches (25 per tx).

### Spending paths
| Path | Who signs | When | Why |
|---|---|---|---|
| `release` | creator + arbiter | the arbiter's policy allows that milestone | milestone tranches; the covenant keeps the rest escrowed |
| `refund` | donor alone | `nLockTime ≥ refundAfter` | the trustless backstop: works even if BitFund disappears |
| `refundFailed` | donor + arbiter | any time | lets donors exit right away when a campaign misses its goal |

### Why an arbiter (vote oracle) at all
A single UTXO's script cannot see the campaign's total, or other donors' votes,
without a shared-state covenant across UTXOs. The requirements allow
"multi-sig or majority donor vote", so the arbiter is a server key that
co-signs **only** when the policy holds (goal met by the deadline for milestone
1; creator update plus a >50% sats-weighted donor vote for milestones 2+).
**The arbiter alone can never take funds**: every release also needs the
creator's signature, and the covenant caps each release at that milestone's
share. A rogue arbiter plus a rogue creator could release early, but only
tranche by tranche, and donors keep the timelocked refund for whatever remains.
That trust boundary is stated in the README.

### Signature scopes (what broke on paper first)
The first sketch used `SIGHASH_SINGLE|ANYONECANPAY` for everything, so that
input *i* pairs with output *i* and many pledges can be released in one tx.
**Problem found while designing:** with SINGLE|ACP signatures, the released
satoshis are not committed to anyone. Anyone who sees the tx could re-wrap the
signed inputs and redirect the payout. **Fix:** the OP_PUSH_TX *preimage* uses
SINGLE|ACP (it only pins the remainder at output *i*), while the creator's and
arbiter's *signatures* are `SIGHASH_ALL|FORKID` and commit to the whole tx.

### Timelock
BSV turned `OP_CHECKLOCKTIMEVERIFY` back into a NOP at Genesis, so the refund
path reads `nLockTime` and `nSequence` from the sighash preimage
(OP_PUSH_TX, sCrypt's `this.timeLock`). The refund tx sets
`lockTime = refundAfter` and a non-final input sequence (`0xfffffffe`).

---

## 2. sCrypt toolchain (d709ac1)

- `scrypt-ts@1.4.5` and `scrypt-cli@0.2.3` live in their own sub-project
  `contracts/` (CommonJS, TypeScript 5.3). **Why:** the main repo is ESM on
  TypeScript 7, and the sCrypt transformer needs TS 5. Keeping them apart
  means the app never loads the sCrypt runtime.
- `npm run compile` (in `contracts/`) compiles and then exports a slim artifact
  (`core/bitfundPledge.artifact.json`: hex template + ABI) for the app.
- **What broke:** the first compile failed with
  `Public method release not ended with assert()`, because sCrypt requires every
  public method to end in an `assert`. Fixed by moving the covenant check into
  a final `assert(remaining == 0n || hash256(...) == ctx.hashOutputs)`.
- **What broke:** `scripts/inspect.cjs` failed with `Cannot find module
  ../dist/contracts/...`, because tsc flattens `dist/`. The path was fixed.

### Runtime without sCrypt: `core/pledge.ts`
Fills the template's `<placeholders>` with minimal pushes, parses scripts
back (canonical re-encoding, so each pledge has exactly one valid script),
computes BIP-143 preimages with `TransactionSignature.format`, and builds
unlocking scripts (`args…, preimage, method index`).

**Verification:**
- `contracts/scripts/crosscheck.cjs` has scrypt-ts itself generate reference
  scripts (`test/fixtures/pledge-scripts.json`); the test asserts
  `core/pledge.ts` matches them **byte for byte**.
- Every spending path is run through the SDK's script interpreter (`Spend`),
  with negative cases: wrong signer, forged preimage, over-release, wrong
  output index, too early, final sequence, block-height lock time.

---

## 3. Size problem → stateless redesign

**What broke:** the first e2e run (14 tests) passed 13. The one failure was
`expected 393 to be greater than 2000`: the creator received only 393 of the
2,750 released sats. The release tx had paid roughly 2,350 sats in fees.

**Why:** the first contract was 3,638 bytes, and each input carries it twice
(the source script, plus inside the preimage push), plus a stateful
continuation output of the same size. At 100 sat/kB (mainnet policy, checked
live on Arcade `/health`) that is about 1,100 sats per pledge per milestone,
which would wipe out real micro-donations.

**Measured with probe contracts:** one `checkPreimage` ≈ 620 bytes; sCrypt's
stateful `buildStateOutput` machinery ≈ +960 bytes.

**Fix: make the contract stateless.** The escrow's value already encodes the
stage: `remaining(s) = pledged − ⌊pledged · cumBps[s−1] / 10000⌋` strictly
decreases, so the contract finds the stage whose remaining equals
`ctx.utxo.value` and requires output *i* to be **the same script** holding
`remaining(s+1)` (`Utils.buildOutput(ctx.utxo.script, next)`).
- Strict decrease needs every 1% step to free ≥ 1 sat, hence
  `MIN_PLEDGE = 100` sats (≈ $0.00004). The indexer and client both enforce it
  (`scheduleIsStrict`). If a value matches no stage, release fails while refunds
  still work (tested).
- Result: template 2,830 bytes, no continuation state. Releasing 3 escrows is
  now **18,649 bytes, a 1,866-sat fee** (≈ 620 sats ≈ $0.0003 per pledge per
  milestone). The e2e test now asserts exactly
  `creator gain == released − fee`.
- What remains is mostly sCrypt's stack shuffling (`OP_ROLL` chains). Trimming
  more would mean hand-written script, which is out of scope for now.

---

## 4. Indexer + arbiter server, client library

### Server (`server/`)
- `db.ts`: knex schema (campaigns, pledges, txs as AtomicBEEF, releases,
  milestone updates, votes). SQLite by default.
- `policy.ts`: pure functions. Campaign view (raised/released/escrowed, status
  `active|funded|failed|completed`), milestone approval, `mayRelease`,
  `mayRefundEarly`.
- `app.ts`: Express.
  - Public reads, SSE live feed, `POST /api/spends` (anyone may report a
    release/refund; the SPV-verified tx is the proof, and the unlocking script's
    method selector says which path ran).
  - BRC-103/104 `createAuthMiddleware` for writes: register campaign (needs the
    on-chain anchor), register pledge (SPV + exact escrow terms + memo), update,
    vote, request arbiter signatures.
  - **The arbiter only signs sighashes it computes itself** from indexed escrow
    outputs, never a hash supplied by the client.

### Client (`client/bitfund.ts`, `client/bitfundApi.ts`)
- `launch`: OP_RETURN anchor of the canonical campaign JSON (its sha256 is the
  campaign id baked into every escrow), then register.
- `donate`: escrow output (kept in the donor's `bitfund pledges` basket with its
  keyID) plus an OP_RETURN memo, then register over AuthFetch.
- `release`: createAction with the escrows as inputs and the remainders at the
  same indexes. Released sats become wallet change, so no extra output or
  internalize step is needed. The client checks the wallet kept the input order
  (the covenant pairs input *i* with output *i*), otherwise it aborts.
- `refund`: `deadline` path (nLockTime, donor only) or `failed` path (arbiter
  co-sign).

### What broke
- **Parallel funding on the mock chain:**
  `UNIQUE constraint failed: mockchain_transactions.txid`. Funding wallets with
  `Promise.all` makes the mock chain mine coinbases at the same moment. Fixed by
  funding wallets one at a time in tests.
- **OP_RETURN parsing:** the SDK keeps everything after `OP_RETURN` as one data
  chunk, so `chunks.length === 6` never matched. Fixed by re-parsing that blob
  with `Script.fromBinary` to read the pushes.
- **Donor keyID lookup for refunds:** I had planned to read it from the donor's
  basket. But once a release spends the original output, the wallet stops
  listing it as spendable. Fix: the keyID (not secret; `'self'` derivation
  needs the root key) is stored with the pledge in the index. The client
  re-derives it and checks it equals the escrow's donor key before refunding.

### Verified
`test/bitfund.e2e.test.ts` (14 tests, real wallet-toolbox wallets, the mock
chain validates every script):
- Funded campaign: launch → 3 pledges with memos → release refused while
  raising → milestone 1 after the deadline (exact fee accounting) → milestone 2
  only after an update and a >50% vote (non-donor vote refused) → final
  milestone → `completed`.
- Failed campaign: early refund refused while raising → arbiter-co-signed refund
  after the deadline → another donor cannot take someone else's pledge →
  timelocked refund with no arbiter → nothing left escrowed.
- Forged escrow (right campaign id, wrong arbiter key) is rejected by the
  indexer.

---

## 5. Production server entry, offline demo, React frontend

### `server/main.ts` (`npm run server`)
- The arbiter is a full **wallet-toolbox** wallet (`Setup.createWalletSQLite`).
  It never holds funds; it derives the per-campaign arbiter keys, signs
  sighashes, and authenticates the API (BRC-103). SPV headers come from
  **Arcade chaintracks** (`ArcadeChainTracker`).
- The root key comes from `BITFUND_ARBITER_KEY`, or is generated once into
  `data/arbiter.key` (mode 600). That file is **git-ignored**, together with
  the arbiter wallet DB, because it is the oracle's signing key.

### `server/demo.ts` (`npm run demo`)
The real server on the mock chain, seeded by real wallets running the same
client code as the browser. It produces one campaign in each state: active,
funded with milestone 1 released and a vote open, completed, and failed with an
early refund. **Why:** judges and teammates can browse the UI without a wallet
or funds. Browser wallet actions need `npm run server` (mainnet), because a
real wallet's transactions don't exist on the mock chain.

### Frontend (`app/`, `npm run app` → :5174)
React 19 + Vite. The brief asked for Next.js/React; Vite keeps the repo light,
and the components are plain React that drop into Next.js unchanged.
- `wallet.tsx`: `WalletClient('auto')` → `waitForAuthentication` → BitFund
  client + AuthFetch.
- `components/DonateButton.tsx`: the donation component (presets, USD
  estimate, on-chain memo, explanation of escrow and refund).
- Pages: Home (tabs Active/Funded/Completed/Missed goal), Campaign (progress,
  milestones with vote bars, **live donor feed over SSE**), Create (goal in
  BSV or USD at the live WhatsOnChain rate, milestone editor), Dashboard
  (creator: post updates, withdraw milestones; donor: reclaim pledges).
- Vite proxies `/api` and `/.well-known` (the BRC-103 handshake) to :8787, so
  the browser stays same-origin.

### What broke
- **`SyntaxError: The requested module 'knex' does not provide an export named
  'knex'`** under plain Node (tsx). Vitest's interop hid it. Fixed by taking the
  factory from the default export (`knexPkg.knex ?? knexPkg`) in `server/db.ts`
  and `test/helpers/mockchain.ts`.
- **`script[serializedBytes] is not a function`** in the demo. This is the
  duplicate-SDK problem from guide §2: wallet-toolbox (CJS) loads the CJS SDK
  while our ESM code loads the ESM SDK.
  - Attempt 1: tsconfig `paths` → CJS build under tsx. Failed: Node's ESM loader
    can't see that bundle's named exports (`no export named 'LockingScript'`).
  - Fix: run Node entry points with **vite-node** using `vitest.config.ts`,
    which already aliases `@bsv/sdk` to the CJS build. `npm run server` uses the
    same runner, for the same reason.
- **`tsc` errors** when the demo imported the mock-chain helper (CJS vs ESM SDK
  types). Tests were never type-checked by the main tsconfig for this reason,
  so `server/demo.ts` is excluded the same way.
- **Headless Brave hung** even on a `data:` URL (sandbox in this environment),
  so screenshots were taken with Playwright's headless Chromium installed in a
  scratch directory, outside the repo.

### Verified
- `npm test`: **68/68** (38 kit + 16 contract + 14 BitFund e2e); `tsc` clean;
  `vite build app` OK.
- `npm run server` starts on mainnet config and answers `/api/health`.
- `npm run demo` + `npm run app`: all five pages render with **zero console
  errors** (Playwright); screenshots in `docs/screenshots/`.
- **Not verified here:** clicking through with a real BSV Desktop wallet on
  mainnet. No wallet is available in this environment. The same client code
  runs end to end against wallet-toolbox wallets in the e2e tests.

---

## 6. README and cost measurements

- The README now covers the brief's four deliverables: architecture and data
  flow, the contract, the wallet/donation component, and a step-by-step guide.
  It adds an explicit trust model and a list of known limitations.
- **Corrected:** my first README draft estimated a donation at ~2.9 KB / ~290
  sats. Measured in the e2e test it is **3,458 bytes / 346 sats**: the escrow
  output plus the wallet's funding input and change. A release is **18,650
  bytes / 1,866 sats for 3 escrows**. The test prints both figures so the
  README can be re-checked.

---

## 7. Checked against the track requirements: the agent gap

**What I found:** I built from the brief in `cpp_prompt.md`, which never
mentions agents. The developer pack's `TBC26_BSV_Track_Requirements.pdf`
defines the track as "DeFi Rails for Agentic Payments". It requires an AI agent
that makes a payment through the project, plus real on-chain transactions, a
usage/value note and a demo video. BitFund had none of those yet.

**Decision:** of three options (an AI backer that donates; an agent service
that raises its budget on BitFund and pays for APIs over HTTP 402; an LLM
milestone reviewer), the agent service fits the track best. It matches the
PDF's thesis (agents paying for APIs) and its listed example ("a launchpad
where agent-powered services raise funds"). The LLM reviewer makes no payment,
so it can't satisfy the rule on its own.

**Added:**
- `docs/USAGE_AND_VALUE.md`: the required note. It covers the problem, users,
  usage, value for BSV, and a built/pending status table.
- `docs/prompts/BUILD_AGENT_SERVICE.md`: a self-contained prompt for building
  the agent service. It lists the reuse points, safety caps, tests, the mainnet
  runbook and known pitfalls.

**Still open:** stablecoin or cross-chain liquidity, which the adoption
criterion rewards, is roadmap only.

---

# Building the agent service (option 2), step by step

We're following `docs/prompts/BUILD_AGENT_SERVICE.md`. The idea in one line:
an AI agent raises its own budget on BitFund, gets paid as it delivers, and
spends that money on a pay-per-call data API.

## Step 0: housekeeping

We copied `AGENTS.md` from the developer pack into the repo root, so any coding
assistant that opens the project sees the BSV rules first. Then we ran the
suite to know where we stand: 68 passing. There's no Anthropic API key on this
machine, so the plan is to write the real Claude "brain" and also a mock
brain, so tests never depend on the network.

## Step 1: something for the agent to buy, and a wallet that can say no

**The data shop (`agent/dataProvider.ts`).** The agent needs a real service to
pay for, so we built a tiny API that sells air-quality readings for ten European
cities at 50 sats a call. It's protected by the official BRC-121 middleware
(`@bsv/402-pay`): ask without paying and you get a `402 Payment Required` with
the price and the shop's identity key. We were upfront that the numbers are
synthetic (generated from the city and date, and flagged `synthetic: true`).
The thing we're demonstrating is the payment rail, and a real data seller could
swap in real data without touching the payment code.

**The careful payer (`agent/pay402.ts`).** The starter kit's `create402Fetch`
pays whatever the server asks. That's fine for a human clicking a button, but
scary for an autonomous agent. So we split the flow in two:
1. ask normally and read the price from the 402 response;
2. check that the shop is on the agent's allow-list and the price is under its
   cap. Only then build the payment (`constructPaymentHeaders`) and ask again.

If either check fails, nothing is paid. We also pull the payment's txid out of
the payment header, so every purchase can go in the agent's spending log and
link to WhatsOnChain later.

**How we checked it (`test/agent.pay402.test.ts`).** Real wallet-toolbox wallets
on the mock chain:
- the agent buys Munich's data and the shop's balance goes up by exactly 50 sats;
- a greedy shop charging 5,000 sats is refused and the agent's balance doesn't move;
- a shop that isn't on the allow-list is refused even with a generous cap.

All three passed on the first run. Nothing broke this time, which is mostly
thanks to the starter kit having already solved the awkward bit (the
`withHostOriginator` workaround for wallet-toolbox wallets).

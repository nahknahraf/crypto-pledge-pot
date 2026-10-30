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

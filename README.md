# BitFund: trustless milestone crowdfunding on BSV

*(Repository: Crypto Pledge Pot)*

On BitFund, donations go into **sCrypt escrow contracts**, not to the creator.
Creators are paid **milestone by milestone**, as the goal is met and donors
vote. If a campaign fails, donors **take their sats back from the script
itself**. Fees are a fraction of a cent, so tiny donations are practical.

![Campaign page](docs/screenshots/funded.png)

| | |
|---|---|
| Escrow | One sCrypt `BitFundPledge` UTXO per donation: parallel, no contention |
| Wallets | Any BRC-100 wallet (BSV Desktop). Keys never leave the wallet |
| Release | Creator + arbiter signatures. A covenant keeps the unreleased part escrowed |
| Refund | Donor alone after the refund date (nLockTime), or immediately if the campaign failed |
| Audit | Campaign JSON and every donation memo written on chain (`OP_RETURN`) |
| Stack | `@bsv/sdk`, `@bsv/wallet-toolbox`, BRC-29/42/43/46/62/95/100/103/104, Arcade, sCrypt |

Team: Farhan · Finja · Louisa

---

## 1. System architecture and data flow

```
 Browser (React)                     BitFund server (Express)                    BSV blockchain
 ───────────────                     ────────────────────────                    ──────────────
 WalletClient ──BRC-100──▶ BSV Desktop (keys, approvals)
      │
      │ createAction: escrow output + OP_RETURN memo ───────────────────────────▶ broadcast (Arcade)
      │ AtomicBEEF ──AuthFetch (BRC-103/104)──▶ /api/pledges
      │                                         SPV verify (Arcade headers)
      │                                         check escrow terms = campaign
      │                                         index (SQLite) ──▶ SSE live feed
      │
 creator: release ─ unsigned tx ──AuthFetch──▶ /release-signatures
      │                                         policy: goal met / donor vote
      │                                         arbiter wallet (wallet-toolbox)
      │◀──────────── arbiter SIGHASH_ALL sigs ── signs sighash IT computed
      │ creator sigs (createSignature) + OP_PUSH_TX preimage → signAction ──────▶ covenant enforced by miners
      │ AtomicBEEF ───────────────────────────▶ /api/spends (index follows the escrow)
      │
 donor: refund ── after refundAfter: donor sig only ────────────────────────────▶ nLockTime path (no server)
```

**Off chain (indexer):** campaign metadata, the pledge index, votes, progress
updates, and the BEEF needed to spend each escrow. **On chain:** the money and
the rules. Each escrow binds `sha256(campaign JSON)`, the creator, arbiter and
donor keys, the release schedule and the refund date. The index can be rebuilt
from the chain: campaigns and memos are `OP_RETURN` records (`core/campaign.ts`).

### Campaign lifecycle
| Status | When | What can happen |
|---|---|---|
| `active` | before the deadline | donations |
| `funded` | deadline passed, goal met | milestone 1 releases; later milestones need a creator update + YES from donors holding > 50% of pledged sats |
| `failed` | deadline passed, goal missed | arbiter co-signs immediate refunds |
| `completed` | all milestones released | nothing left in escrow |
| any | after `refundAfter` | donors reclaim whatever is still escrowed, **alone** |

### Trust model (honest version)
- **Donor safety needs no trust:** after `refundAfter` the contract lets the
  donor reclaim the remainder with only their own signature.
- **The creator can never take funds alone.** Every release needs the arbiter
  too, and the covenant limits each release to that milestone's share.
- **The arbiter** (vote oracle) is a server key. It cannot spend anything by
  itself. If the creator and arbiter collude, they could release milestones
  early, but only one tranche at a time and never past the schedule. The
  arbiter can be swapped for an M-of-N multisig without changing the app's
  architecture.
- All-or-nothing cannot stop a creator from backing their own campaign to reach
  the goal. That is true of every all-or-nothing platform.

---

## 2. The sCrypt contract: `contracts/src/contracts/bitfundPledge.ts`

```ts
export class BitFundPledge extends SmartContract {
  @prop() campaignId: ByteString      // sha256(canonical campaign JSON)
  @prop() creator: PubKey             // BRC-42 derived
  @prop() arbiter: PubKey             // vote oracle
  @prop() donor: PubKey               // BRC-42 derived
  @prop() pledged: bigint
  @prop() cumulativeBps: FixedArray<bigint, 4>   // e.g. [2500, 5000, 10000, 10000]
  @prop() refundAfter: bigint         // unix time

  @method(SigHash.ANYONECANPAY_SINGLE)
  public release(creatorSig: Sig, arbiterSig: Sig) {
    // stage = the one whose remaining amount equals this UTXO's value
    // → output i must be THIS script holding remaining(stage + 1)
    assert(found && (next == 0n || hash256(Utils.buildOutput(this.ctx.utxo.script, next)) == this.ctx.hashOutputs))
    assert(this.checkSig(creatorSig, this.creator))
    assert(this.checkSig(arbiterSig, this.arbiter))
  }

  @method() public refund(donorSig: Sig) {                     // trustless backstop
    assert(this.timeLock(this.refundAfter))
    assert(this.checkSig(donorSig, this.donor))
  }

  @method() public refundFailed(donorSig: Sig, arbiterSig: Sig) // campaign failed
}
```

Design notes:
- **Stateless.** The escrow's own value tells which milestone it is at, because
  remaining amounts strictly decrease (pledges must be ≥ 100 sats, so each 1%
  step frees ≥ 1 sat). This cut the script from 3.6 KB to 2.8 KB and removed
  sCrypt's state machinery (see `docs/DEVLOG.md` §3).
- **Batch releases.** The covenant preimage is `ANYONECANPAY|SINGLE`, so input
  *i* pairs with output *i* and many escrows release in one transaction. The
  signatures are `SIGHASH_ALL`, so nobody can redirect the released sats.
- **Timelock.** `OP_CHECKLOCKTIMEVERIFY` has been a NOP on BSV since Genesis,
  so the contract reads `nLockTime`/`nSequence` from the preimage (OP_PUSH_TX).

**Runtime without the sCrypt toolchain:** `core/pledge.ts` fills the compiled
template, parses scripts, builds BIP-143 preimages and unlocking scripts with
`@bsv/sdk`. A test checks it matches scrypt-ts **byte for byte**, and every path
is run by the SDK script interpreter.

---

## 3. Wallet and donation component

`app/src/components/DonateButton.tsx` (React) uses `client/bitfund.ts`:

```ts
// app/src/wallet.tsx
const wallet = new WalletClient('auto')              // BSV Desktop over BRC-100
await wallet.waitForAuthentication({})
const bitfund = new BitFund(wallet, new BitFundApi(origin, wallet))

// DonateButton → bitfund.donate(meta, sats, { name, message })
const donorKey = await wallet.getPublicKey({ protocolID: [1, 'bitfund donor'], keyID, counterparty: 'self' })
await wallet.createAction({
  description: `Pledge to ${meta.title}`,
  outputs: [
    { lockingScript: pledgeScriptFor(meta, donorKey, sats).toHex(), satoshis: sats,
      basket: 'bitfund pledges', customInstructions: JSON.stringify({ protocolID, keyID, campaignId }) },
    { lockingScript: pledgeMemoScript(campaignId, memo).toHex(), satoshis: 0 }   // OP_RETURN
  ],
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})
// → AtomicBEEF posted with AuthFetch; the indexer verifies SPV and pushes it to the live feed
```

Release and refund use `createAction` + `signAction`. The app computes each
sighash and asks the wallet to `createSignature({ hashToDirectlySign })` with
the derived key, then assembles the sCrypt unlocking script.

---

## 4. Step-by-step: run it locally

Requires Node.js ≥ 22.

```bash
npm install
npm test                 # 68 tests: contract, mock-chain end to end, plus the original token kit
```

**Explore the UI with no wallet (offline demo):**
```bash
npm run demo             # server on :8787, mock chain, seeded campaigns in every state
npm run app              # http://localhost:5174
```

**Real use on mainnet with BSV Desktop:**
```bash
# 1. Install and unlock BSV Desktop: https://github.com/bsv-blockchain/bsv-desktop/releases
npm run server           # indexer + arbiter on :8787 (Arcade SPV). Creates data/arbiter.key: back it up!
npm run app              # http://localhost:5174 → Connect wallet → Start a campaign / Donate
```
Env for the server: `BITFUND_ARBITER_KEY`, `NETWORK=main|test`, `PORT`,
`BITFUND_DB`, `ARBITER_WALLET_DB` (see `server/main.ts`).

**Recompile the sCrypt contract** (optional; the compiled artifact is committed):
```bash
cd contracts && npm install
npm run compile          # scrypt-cli compile + export the artifact to core/
npm run build && npm run crosscheck   # regenerate the byte-for-byte fixtures
cd .. && npm test
```

### Repository map
| Path | What |
|---|---|
| `contracts/` | sCrypt contract (own TS 5 sub-project), compiled artifacts |
| `core/pledge.ts` | escrow runtime: script template, preimages, unlocks, schedule maths |
| `core/campaign.ts` | campaign model, id, validation, OP_RETURN records |
| `client/bitfund.ts` · `client/bitfundApi.ts` | wallet flows · HTTP/AuthFetch API client |
| `server/` | indexer + arbiter (`app.ts`, `policy.ts`, `db.ts`), `main.ts`, `demo.ts` |
| `app/` | React frontend |
| `test/pledge.script.test.ts` · `test/bitfund.e2e.test.ts` | contract tests · end-to-end flows |
| `docs/DEVLOG.md` | engineering log: decisions, what broke, fixes |
| `overlay/`, `client/token.ts`, `web/`… | the BSV-21 token kit this project started from (still tested) |

### Costs (measured, 100 sat/kB mainnet policy)
- Donation: measured 3,458 bytes → 346 sats fee (≈ $0.00006 at $17/BSV), including the wallet's funding input and change.
- Releasing a milestone: ~6.2 KB per escrow → ~620 sats (≈ $0.0001).
  A 3-escrow release measured 18,650 bytes / 1,866 sats. Both figures are printed by `test/bitfund.e2e.test.ts`.

### Known limitations
- Not yet exercised with a real BSV Desktop wallet on mainnet; the identical
  code runs end to end against wallet-toolbox wallets in the tests.
- The arbiter is a single key; an M-of-N guardian set is the next step.
- If a refund or release is not reported to `/api/spends`, the index stays
  stale until someone reports it; a chain watcher (Arcade/WoC spent lookups)
  would close that gap.

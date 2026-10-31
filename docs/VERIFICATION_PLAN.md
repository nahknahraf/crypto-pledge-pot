# Verification plan: every piece, normal and edge cases

**Goal:** for each piece of CryptoPledgePot, list what "working" means, which
tests already prove it, and which normal and edge cases are still unproven.
Then close the gaps in a fixed order.

**Status on 30 Oct 2026:** 149 tests pass in 23 files (`npm test`), and both
typechecks are clean (`npm run typecheck`, `npm run typecheck:mock`). This
document does not repeat what those tests do. It marks each case as follows:

- ✅ already covered (with the test file);
- ➕ to add (an offline test on the mock chain);
- 🌐 needs the real network (mainnet or testnet, run by hand, with a recorded txid).

## How to run each level

| Level | Command | Network | Cost |
|---|---|---|---|
| L0 Static | `npm run typecheck && npm run typecheck:mock` | none | 0 |
| L1 Script | `npm test -- pledge.script swap.script` | none (sCrypt interpreter, the SDK `Spend`) | 0 |
| L2 Offline end to end | `npm test` | wallet-toolbox mock chain | 0 |
| L3 Contract cross-check | `npm run contracts:crosscheck` | none | 0 |
| L4 Container | `podman build` + `docker compose up` (DOCKER.md) | none | 0 |
| L5 Mainnet smoke | the manual checklist in §10 | **mainnet**, team wallet only | about 5,000 sats |

**Rules that apply to every level:**

- L5 is run only by a person, from a team wallet.
- No browser automation may click a payment button while BSV Desktop is listening (ports 3321 and 2121).
- Each L5 txid is written into `docs/USAGE_AND_VALUE.md`.

---

## 1. Escrow contract (`contracts/`, `core/pledge.ts`)

| Case | Kind | Status |
|---|---|---|
| Locking script equals the scrypt-ts output byte for byte | normal | ✅ `pledge.script` |
| Release of milestone 1 keeps the remainder escrowed at stage 1 | normal | ✅ `pledge.script` |
| Walk every milestone; the last one releases everything | normal | ✅ `pledge.script` |
| Release more than allowed, remainder to another script or index | edge | ✅ `pledge.script` |
| Escrow value matching no stage | edge | ✅ `pledge.script` |
| Forged preimage; one signature missing | edge | ✅ `pledge.script` |
| Refund before the date, final sequence, block-height lock time | edge | ✅ `pledge.script` |
| refundFailed needs both signatures | edge | ✅ `pledge.script` |
| Pledge exactly `MIN_PLEDGE` (100) and 99 | edge | ➕ the stage arithmetic at the smallest amount, and the client refuses 99 |
| Pledge whose rounding makes two stages equal (e.g. 101 sats, 3 milestones) | edge | ➕ `scheduleIsStrict` must refuse it before broadcast |
| 1 milestone at 100 %, and 10 milestones | edge | ➕ |
| Largest realistic pledge (21e14 sats) | edge | ➕ no overflow in `escrowedAfter` |
| `refundAfter` exactly equal to nLockTime | edge | ✅ (`>=`) |
| Two pledges released in one transaction (ANYONECANPAY\|SINGLE pairing) | normal | ➕ input *i* pairs with output *i* |
| Unlock size estimate equals the real size (`unlockLength`) | normal | ➕ a fee estimate that is too low means a rejected broadcast |

## 2. Atomic swap contract (`core/swap.ts`)

| Case | Kind | Status |
|---|---|---|
| Byte-for-byte cross-check, parse back | normal | ✅ `swap.script` |
| Claim with the right secret and receiver signature | normal | ✅ |
| Wrong or short secret, no signature | edge | ✅ |
| Refund too early, by another party, with a final sequence | edge | ✅ |
| Secret of 0 bytes, 31 bytes, 33 bytes | edge | ➕ (only "short" is tested) |
| The secret read from a claim tx equals the original (`secretFromClaim`) on a real tx | 🌐 | needed before any real bridge (BRIDGING_PLAN Phase 1) |

## 3. Campaign records and rules (`core/campaign.ts`)

| Case | Kind | Status |
|---|---|---|
| Campaign/pledge/report records round-trip | normal | ✅ `rules`, `recovery.e2e` |
| Legacy `bitfund` tag still parses | normal | ✅ `recovery.e2e` |
| Report hash anchor matches; a tampered report fails | normal/edge | ✅ `agent.trust` |
| `validateCampaign`: percent ≠ 100, deadline in the past, refundAfter < deadline, empty title, 0 milestones | edge | ➕ a table-driven test |
| Unicode / 10 kB description / emoji in the memo | edge | ➕ size limit of the OP_RETURN, rendering |
| `agentUrl` that is not http(s) (`javascript:`) | edge | ➕ must be refused, because the web app links it |

## 4. Server (`server/app.ts`, `db.ts`, `policy.ts`)

| Case | Kind | Status |
|---|---|---|
| Full lifecycle: launch → pledge → release 1..n → complete | normal | ✅ `cryptoPledgePot.e2e`, `e2e.mockchain` |
| Release refused while raising; vote needed for milestone ≥ 2 | edge | ✅ |
| Only the creator can ask for signatures or post updates | edge | ✅ |
| Escrow with the wrong arbiter key refused | edge | ✅ |
| Oversized / malformed body → JSON error | edge | ✅ `server.hardening` |
| Rate limits per visitor; X-Forwarded-For only from trusted proxies | edge | ✅ `server.hardening` |
| Same pledge tx submitted twice (idempotent) | edge | ➕ |
| Pledge arriving after the deadline | edge | ➕ refused or recorded as late, but never counted twice |
| Vote tie (exactly 50 %) | edge | ➕ the policy says ">50 %", so a tie must fail |
| Voter who pledged 0 or already refunded | edge | ➕ the vote weight must be 0 |
| Vote changed twice; vote on a milestone already released | edge | ➕ |
| Pledge BEEF whose SPV proof does not verify | edge | ➕ must be refused (tests use the mock chain tracker, which is permissive) |
| Two server processes on one DB (SQLite lock) | edge | ✅ refused by a lock next to the DB (DEVLOG 8.38) |
| Server restart mid-release (signatures handed out, tx not broadcast) | edge | ➕ the next request must give the same signatures, and the watcher must catch the broadcast |

## 5. Watcher, import and claims (`server/watcher.ts`, `importTx.ts`)

| Case | Kind | Status |
|---|---|---|
| Finds an unreported release and an unreported refund | normal | ✅ `watcher` |
| Re-import is a no-op; a foreign arbiter is refused | normal/edge | ✅ `recovery.e2e` |
| Only the real donor can claim an imported pledge | edge | ✅ |
| WhatsOnChain answers 429 / 500 / times out | edge | ➕ back off and keep the index unchanged |
| A chain reorg drops a release tx | edge | ➕ the watcher must re-check (doc-only acceptable) |

## 6. Client and wallet flows (`client/`)

| Case | Kind | Status |
|---|---|---|
| Donate, release, vote, claim, refund, reclaimEscrow | normal | ✅ e2e tests |
| Reclaim using chain data only (server gone) | edge | ✅ `recovery.e2e` |
| The user cancels in the wallet (createAction rejected) | edge | ➕ no DB row, and a clear message |
| The wallet has too few sats for amount + fee | edge | ➕ |
| The server accepted the broadcast but the reply was lost | edge | ➕ retry `/api/pledges` with the same BEEF |
| Arcade is down → fallback broadcaster | 🌐 | manual |

## 7. Web app (`app/src`)

| Case | Kind | Status |
|---|---|---|
| Network guard: in `mock`, no wallet call is ever made | edge | ✅ server side (`server.hardening`); ➕ a component test that `WalletClient` is never constructed |
| `confirmSpend` dialog shows the amount and the network before every payment | normal | ➕ a component test |
| The wallet is on testnet but the server is on mainnet | edge | ➕ refuse with a message |
| No wallet installed | edge | ➕ the read-only browsing still works |
| SSE feed reconnects after the server restarts | edge | ➕ |
| Pages render with 0 campaigns, 0 pledges, 200 pledges | edge | ➕ |

## 8. Docker and sharing

| Case | Kind | Status |
|---|---|---|
| Image builds with Podman rootless; compose `app`, `tunnel`, `demo`, `agent-demo` profiles start | normal | ✅ manual (DEVLOG) |
| Empty env var → key generated once, then reused | edge | ✅ `keys` |
| Container restart keeps the DB and keys (volume) | edge | ➕ manual check, recorded in DOCKER.md |
| ngrok on 8081: no redirect loop | edge | ✅ manual |
| `/@fs` and `data/` are not reachable through the share URL | edge | ➕ a curl check in `scripts/share.sh --check` |

## 9. Demos

| Case | Kind | Status |
|---|---|---|
| `demo:agent` plays every beat | normal | ✅ `agentDemo.e2e` |
| `demo:swap` both acts | normal | ✅ `swapDemo` |
| `demo` (classic) | normal | ➕ a smoke test like `agentDemo.e2e` |

## 10. Mainnet smoke checklist (L5, by hand)

1. `NETWORK=main npm run server` with a fresh DB. Check that `/api/health` says `main`.
2. Launch a 1-milestone campaign, goal 1,000 sats, deadline +10 min, refundAfter +1 day.
3. Pledge 1,000 sats from BSV Desktop. Record the txid.
4. After the deadline, release. Record the txid. Check WhatsOnChain: the escrow is spent and the creator output is there.
5. Second campaign with a 600-sat pledge. Let it fail and refund with the arbiter. Record the txid.
6. Stop the server, delete nothing, start again. Run the watcher. The index must be unchanged.
7. Write every txid into `docs/USAGE_AND_VALUE.md`.

## Order of work

1. The ➕ edge cases in §4 (vote tie, double submit, bad SPV). These are where a judge can break the demo.
2. §1 rounding and `MIN_PLEDGE` cases, and the two-pledge release.
3. §6 wallet cancel and insufficient funds, then §7 component tests.
4. The §10 mainnet smoke run (needs team sats).

# Giving routines: team notes

*"Spende jeden Monat 10 Euro an einen Tierschutzverein."* A user types this in a
chat, and CryptoPledgePot turns it into a **giving routine**. Whenever it is
due, the routine makes a pledge into a matching campaign's escrow in one of two
ways:
- **Manual:** the user approves each gift in their own wallet.
- **Automatic:** the user's own **routine agent** runs it without asking, from
  a budget the user moved into the agent (see §7).

This note explains the concept, the data model, the API, how a run works, the
trust model, and how ZK authentication will plug in later.

- **Page:** `#/routines` ("Giving routines" in the navigation).
- **Code:**
  - [`core/routines.ts`](../core/routines.ts): shared rules
  - [`server/routines.ts`](../server/routines.ts): API
  - [`server/routineInterpreter.ts`](../server/routineInterpreter.ts): chat → draft
  - [`client/routineRunner.ts`](../client/routineRunner.ts): plan and execute a run (shared by browser and agent)
  - [`app/src/routines.ts`](../app/src/routines.ts): stores
  - [`app/src/pages/Routines.tsx`](../app/src/pages/Routines.tsx) and [`app/src/components/RoutineAgentCard.tsx`](../app/src/components/RoutineAgentCard.tsx): UI
  - [`agent/routineAgent.ts`](../agent/routineAgent.ts), [`agent/routineAgentHttp.ts`](../agent/routineAgentHttp.ts) and [`agent/routineAgentMain.ts`](../agent/routineAgentMain.ts): the routine agent
- **Tests:**
  - [`test/routines.test.ts`](../test/routines.test.ts): rules, 21 tests
  - [`test/routines.e2e.test.ts`](../test/routines.e2e.test.ts): real wallets on the mock chain + server, including the routine agent, 15 tests

---

## 1. Concept in one paragraph

A routine is a **standing instruction, not a standing permission**. It records
what the user wants to give, how often, to what kind of cause, and the hard
limits. When it is due, the app works out a concrete proposal: which open
campaign matches, and how many sats the amount is worth today. A wallet then
creates a **normal CryptoPledgePot pledge** (an sCrypt escrow output):
- **Manual:** the user's own wallet, after the user confirmed it.
- **Automatic:** the user's routine agent's wallet, with no question asked.

The server records that the pledge executed the routine, but only after
checking it. The user's own keys never leave their wallet. The platform server
never holds money or a key to anyone's money.

## 2. How it compares to the other agents

| | Fundraising agent (AirWatch) | Donor agent (`npm run donor`) | **Giving routines** (this) |
|---|---|---|---|
| Who it acts for | a campaign creator | one donor | any logged-in donor |
| Where it runs | its own process + wallet | the donor's machine | web app + server; automatic: the routine agent on the user's machine |
| Holds money? | yes, its released budget | autopilot: yes, a budget; co-pilot: no | manual: **never**; automatic: only the budget the user moved into the routine agent |
| Signs transactions? | yes (own wallet) | autopilot: yes | manual: only the user's wallet; automatic: the routine agent's own wallet |
| Input | mission + milestones | a JSON mandate | **one chat sentence** |

Routines are the lightest of the three. The donor agent *chooses* causes for
the donor; the routine agent only *carries out* what the user wrote down.

---

## 3. The flow

```
 user types a sentence
        │
        ▼
 ┌──────────────────────┐   POST /api/routines/interpret   ┌───────────────────────────┐
 │ Routines page (React)│ ───────────────────────────────▶ │ server: Claude or rules   │
 │                      │ ◀─────────────── ParseResult ─── │ (never sets the limits)   │
 │ 1. shows what it     │                                  └───────────────────────────┘
 │    understood        │
 │ 2. user sets the     │   POST /api/routines {draft}     ┌───────────────────────────┐
 │    cap per run       │ ───────────────────────────────▶ │ validateDraft → store     │
 │ 3. "Create routine"  │                                  │ (owner = verified caller) │
 │                      │                                  └───────────────────────────┘
 │ ... when due ...     │
 │ 4. planRun: matching │   GET /api/campaigns
 │    campaign + sats   │
 │ 5. user confirms     │
 │ 6. wallet: pledge ───┼──▶ BSV Desktop (BRC-100) ──▶ sCrypt escrow output on chain
 │    into the escrow   │        POST /api/pledges (SPV-verified, indexed, as for any donation)
 │ 7. report the run    │   POST /api/routines/:id/runs {pledgeId}
 │                      │ ───────────────────────────────▶ owner? target? limits? once?
 └──────────────────────┘                                  → applyRun → next due date
```

Steps 6–7 reuse the existing donation path (`CryptoPledgePot.donate`)
unchanged. A routine run is indistinguishable on chain from a hand-made
donation, except for its OP_RETURN memo `Giving routine: <cause>`.

---

## 4. Data model (`core/routines.ts`)

```ts
type RoutineInterval = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
type RoutineCurrency = 'EUR' | 'USD' | 'SATS'
type RoutineStatus   = 'active' | 'paused' | 'completed' | 'cancelled'

type OwnerRef =                                  // who owns it (see §9)
  | { scheme: 'brc103', identityKey: string }    // today
  | { scheme: 'zk', commitment: string }         // ZK branch, later

interface RoutineDraft {
  text: string                                   // the user's sentence, kept for transparency
  amount: { value: number, currency: RoutineCurrency }
  interval: RoutineInterval
  target: { label: string, keywords: string[], campaignId?: string }
  limits: { maxSatsPerRun: number, maxRuns: number | null, maxTotalSats: number | null }
}

interface Routine extends RoutineDraft {
  id: string                                     // 16 random bytes, hex
  owner: OwnerRef
  executor?: { identityKey: string, since: number } | null  // routine agent allowed to run it automatically (§7)
  status: RoutineStatus
  createdAt: number                              // unix seconds
  nextRunAt: number | null                       // null once final
  runs: RoutineRun[]
}

interface RoutineRun {
  at: number
  campaignId: string
  campaignTitle: string
  sats: number
  pledgeId: string                               // escrow outpoint "txid.vout": the on-chain proof
  simulated?: boolean                            // offline demo only
}
```

**Design choices:**
- **Fiat amounts stay fiat.** "10 euros a month" is converted at each run (EUR
  from CoinGecko, USD from WhatsOnChain), so the gift keeps its value. The
  **cap is in sats** and fixed. If BSV drops so far that 10 € is more than the
  cap, the run is refused rather than quietly overspending.
- **Default cap = today's value + 50 %.** It is shown in the confirmation card
  and the user can change it before saving. For sats amounts the cap equals
  the amount.
- **Target = keywords, optionally a pinned campaign.** "Tierschutzverein"
  expands to `animal, wildlife, shelter, pet, dog, cat, …`, so it finds an
  "elephant tracking" campaign. Each run picks the best **open** match (status
  `active`, deadline not passed; title hits weigh 3×, description hits 1×).
- **Schedules count from the due date, not the approval date.** A monthly
  routine stays on its day of the month even if the user approves a few days
  late. Calendar months use UTC (31 Jan + 1 month = 3 Mar, as `Date` does).
- **Resuming a paused routine** makes it due now once, not once per missed
  period.
- **Status changes:** `active ⇄ paused`, either → `cancelled`. `completed` and
  `cancelled` are final.
- **A routine completes** after a one-off run, after `maxRuns` runs, or when
  the next run could not fit under `maxTotalSats`.
- **Stored as one JSON column** (`routines.data`), indexed by
  `owner = ownerKey(owner)`, e.g. `brc103:02ab…`. Routines are only ever read
  whole and only by their owner, so there is nothing to join on.

## 5. Reading the chat (`parseRoutineText` and `server/routineInterpreter.ts`)

There are two interpreters behind one interface (`RoutineInterpreter`):

- **Rules (default, offline):** a German/English parser.
  - **Amounts:** `10 Euro`, `10€`, `€10`, `2,50 EUR`, `$5`, `5000 sats`, `0.001 bsv`.
  - **Intervals:** `jeden Monat` / `monatlich` / `every month` / `monthly`; the
    same for day, week and year; `einmalig` / `once`. If no interval is named, the gift is one-off.
  - **Counts:** `für 6 Monate`, `for 3 years`, `12 mal`, `12 times`.
  - **Cause:** whatever follows `an` / `to` / `für` / `for`, without articles.
  - If the amount or the cause is missing, it asks back in the user's language.
- **Claude (when `ANTHROPIC_API_KEY` is set on the server):** reads harder
  phrasings with structured output (zod). It follows the same rule as the
  fundraising agent's brain: **the model decides what was asked, never how
  much may be spent.**
  - It cannot set `maxSatsPerRun`.
  - Its draft goes through the same `validateDraft`.
  - It falls back to the rules on refusal or error.
  - `ROUTINE_INTERPRETER=rules` forces the rules even with a key.
  - The endpoint is authenticated, so anonymous visitors cannot spend the API budget.

In the offline demo, and before the wallet is connected, the browser runs the
rule parser itself.

## 6. API (`server/routines.ts`)

All routes are **authenticated** (BRC-103/104 via `AuthFetch`; mounted after
the auth middleware) and rate-limited like the other authenticated routes.

| Method and path | Body | Returns | Checks |
|---|---|---|---|
| `POST /api/routines/interpret` | `{ text }` | `{ result: ParseResult, interpreter }` | authenticated caller |
| `GET /api/routines` | – | `Routine[]` (the caller's own) | – |
| `POST /api/routines` | `{ draft }` | `Routine` (due now) | `validateDraft`; at most 50 open routines per user |
| `POST /api/routines/:id/status` | `{ status }` | `Routine` | owner; allowed transition |
| `POST /api/routines/:id/executor` | `{ identityKey \| null }` | `Routine` | owner only; a valid key, not the owner's own; routine not final |
| `GET /api/routines/delegated` | – | `Routine[]` delegated to the caller | for the routine agent |
| `POST /api/routines/:id/runs` | `{ pledgeId }` | `Routine` | see below |

**What `POST /runs` checks before it records anything:**
1. The caller is the routine's **owner**, or the **executor** the owner
   delegated it to. For anyone else the answer is 404.
2. The pledge is already in the index. It got there through `POST /api/pledges`,
   which SPV-verified it and checked the escrow script against the campaign.
3. It is the **caller's** pledge (`donorIdentity`), made **after** the routine
   was created.
4. It is **not already counted** for any of the owner's routines.
5. Its campaign **matches the routine's target** (`matchesTarget`).
6. `checkRun`: the routine is active and due, the amount is ≥ 100 sats and
   ≤ `maxSatsPerRun`, and neither `maxTotalSats` nor `maxRuns` is exceeded.

Someone else's routine id returns **404**, not 403, so ids cannot be probed.
The client methods are in `client/cryptoPledgePotApi.ts`:
- `interpretRoutine`, `routines`, `createRoutine`, `setRoutineStatus`, `recordRoutineRun`;
- `setRoutineExecutor` and `delegatedRoutines` for automatic execution.

## 7. Automatic execution: the routine agent

The user wanted gifts to happen without approving each one. Something has to
sign without asking, and **AGENTS.md rules out a platform server key that
controls users' assets**. So the signer is the user's **own routine agent**:

- **Where it runs:** on the user's machine (`npm run routine-agent`). Its API
  listens on 127.0.0.1 and is reached only through the local dev server
  (`/routine-agent` proxy), never through a public link.
- **Its own wallet:** generated root key in `data/routine-agent.key`
  (git-ignored). It never sees the user's keys.
- **Budget:** the user tops it up from their wallet (a BRC-29 payment), and
  that is all it can ever spend. The **first funder becomes its owner**.
  "Withdraw all" can only pay that owner, whoever asks.
- **Delegation per routine:** "Automatic" calls
  `POST /api/routines/:id/executor` with the agent's identity key; "Manual"
  sends `null` and revokes it at once.
  - Only the owner can delegate; the agent cannot grant itself anything.
  - The agent only runs routines whose owner is its own owner. Someone else
    delegating to its key gets nothing from its budget.
- **The loop** (every `ROUTINE_AGENT_INTERVAL_S`, default 60 s):
  1. List delegated routines.
  2. For each due one, plan it with the same `planRun` as the browser.
  3. Check its own limits:
     - ≤ `ROUTINE_AGENT_MAX_SATS_PER_ROUND` (default 1,000,000) per round;
     - budget ≥ amount + fee.
  4. Pledge, then report the run. The server checks it like any other run.
- **Skips** are logged once per reason, not every minute. Reasons: no
  matching open campaign, no exchange rate, over a cap, budget too low. The
  routine stays due and the agent tries again next round.
- **The pledge belongs to the agent's wallet.**
  - If a campaign fails, the refund goes back into the agent's budget, not
    straight into the user's wallet.
  - Votes on milestones are the agent's to cast. It does not vote today, so
    those pledges simply don't count as votes.
  - Withdraw to get the budget back.

**In the offline demo** the page simulates the agent: a fixed budget of
1,000,000 sats, runs recorded as simulated, no wallet. Due automatic routines
run within ~4 seconds, which suits a demo video. The real agent refuses to
start against a `mock` server.

## 8. Trust model: why this is non-custodial

| Risk | Why it can't happen |
|---|---|
| The server spends the user's money | It has no key of the user's or of the routine agent's. |
| The agent spends the user's money | It has no key of the user's. It spends only its own budget, which the user chose to move into it, and can always withdraw. |
| Manual runs happen without consent | Every manual run is `wallet.createAction` in the user's BRC-100 wallet, after an in-app confirm **and** the wallet's own approval. |
| The agent pays more than agreed | Each run is ≤ the routine's `maxSatsPerRun`, checked by the agent **and** the server. Each round is ≤ `ROUTINE_AGENT_MAX_SATS_PER_ROUND`. The budget is the hard total. |
| The agent keeps running after the user changed their mind | "Manual" or "Stop" takes effect on the server at once; the agent's next run report is refused (404). |
| A stranger drains the agent | The agent runs only its owner's routines, and withdrawals only pay its owner. Its API is bound to 127.0.0.1. |
| Agent sends money to itself | A run is always a CryptoPledgePot escrow pledge: released only milestone by milestone with arbiter + donor-vote rules, and refundable by the donor (early if the campaign fails, alone after `refundAfter`). |
| The LLM misreads "10 €" as "10 BSV" | The LLM never sets the cap; the user sees the sats amount and the cap before saving (and, for manual runs, again before every run). |
| A price crash makes 10 € cost far more sats | The cap is fixed in sats; the run is refused (by the app and by the server). |
| A compromised server invents runs | Runs only reference real, SPV-verified pledges made by the owner's or their routine agent's wallet; each links to WhatsOnChain. A fake run cannot move money, only bookkeeping. |
| A compromised app proposes a bad campaign | The confirm dialog and the wallet show the campaign and the amount. The escrow terms are checked by the server **and** by the sCrypt script itself. |
| Server is down | Routines can't be listed or recorded, but nothing is at risk: no money depends on the routine store. |

**Honest limits:**
- **Automatic giving needs the routine agent running.** It runs on the user's
  machine, so when the computer is off, due routines wait. That is the price of
  not putting a key on the platform server.
- **The agent's key is a hot key on that machine.** Anyone with access to
  `data/routine-agent.key` can spend the budget, so keep the budget small and
  top it up as needed.
- **Matching is keyword-based.** "Tierschutzverein" matches campaigns that
  mention animals. It does not check that the campaign is a registered
  charity. Pin a campaign (`target.campaignId`) to be exact.
- **Exchange rates come from public APIs** (CoinGecko, WhatsOnChain). If they
  are unreachable, fiat routines cannot run; sats routines still can.

## 9. ZK compatibility (`x-zk-proof`)

The ZK branch (snarkjs / Groth16) will let a user prove "I am a registered
identity" without revealing which identity key. Routines are prepared for it:

1. **Owner is an `OwnerRef`, not a key.** Storage and every check use
   `ownerKey(owner)` (`brc103:<key>` or `zk:<commitment>`), so the two schemes
   cannot collide and no handler reads `req.auth` directly.
2. **One resolver decides who the caller is.** `RoutineOwnerResolver` (today
   `brc103OwnerResolver`). A request that carries `x-zk-proof` is answered with
   **501** for now. It is not silently treated as its BRC-103 identity, so
   ZK clients fail loudly until the server supports them.
3. **Paths and bodies don't change.** A ZK client sends the same requests with
   an `x-zk-proof` header.

**To switch it on, the ZK branch needs to:**
1. Write `zkOwnerResolver(req)`: verify the Groth16 proof with snarkjs against
   the verification key, then return `{ scheme: 'zk', commitment }`. Bind the
   proof to the request (method, path, body hash, a server nonce) so it cannot
   be replayed.
2. Mount the routine routes so that either BRC-103 **or** a valid ZK proof
   passes. Today the BRC-103 middleware rejects everything unauthenticated
   first. Mount these routes before it with `allowUnauthenticated: true` and
   let the resolver decide.
3. Decide how a ZK owner proves that a pledge is theirs in `POST /runs`
   (today: `pledge.donorIdentity === identityKey`). One option: prove control
   of the escrow's `donorKey` with a signature, as `POST /api/pledges/:id/claim`
   already does.
4. In the browser, add a header hook to `CryptoPledgePotApi`: AuthFetch for
   BRC-103, plain fetch plus `x-zk-proof` for ZK.

## 10. Ideas for later

- **Hosted, still trustless:** an sCrypt "standing order" covenant. The user
  locks a budget into a contract that lets anyone (e.g. the server) spend at
  most `maxSatsPerRun` per period, and only into a pledge escrow whose donor
  key is the user's. The remainder goes back into the same contract, and the
  user can reclaim it any time. The agent would no longer need to run on the
  user's machine. The hard part is checking the pledge script inside the
  covenant.
- **Refunds and votes by the routine agent:** reclaim failed campaigns
  automatically (as the donor agent's autopilot does) and abstain or vote on
  milestones.
- **Pre-signed pledges:** the user signs N future pledges at once, each only
  valid after its date (`nLockTime`). This needs a way to keep their inputs
  unspent.
- **Reminders:** MessageBox or e-mail when a routine is due.
- **Better matching:** campaign categories set by creators, or the donor
  agent's due-diligence score as a filter (`score ≥ 60`).

## 11. Running it

- **Offline demo** (no wallet, simulated runs, routines in the browser):

  ```bash
  npm run demo      # server on the mock chain, :8787
  npm run app       # → Giving routines
  ```

  The demo's open campaign is about schools. Try "Donate 5000 sats every week
  to school projects":
  - with "Run automatically" ticked, the simulated agent pays it within seconds;
  - without it, use **Simulate this run**.
- **Mainnet / testnet, manual:** run `npm run server` and `npm run app`. Then
  connect BSV Desktop, create a routine and **Approve & donate**. Set
  `ANTHROPIC_API_KEY` on the server for the Claude interpreter.
- **Mainnet / testnet, automatic:** additionally run

  ```bash
  npm run routine-agent
  ```

  On the page:
  1. **Top up budget**. The first top-up makes your wallet the agent's owner.
  2. Switch a routine to **Automatic** (or tick "Run automatically" when you
     create it).
  3. Watch "What it did". **Run check now** skips the 60-second wait.
- **Tests:**

  ```bash
  npx vitest run test/routines.test.ts test/routines.e2e.test.ts
  ```

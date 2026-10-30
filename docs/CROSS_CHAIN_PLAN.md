# Plan: agents that bring assets into BSV wallets, non-custodially

*30 October 2026 · status: **simplest demoable version built on branch `cross-chain-swap`**: A1 (BSV AtomicSwap), A2 against a *simulated* USDC chain, the donor and liquidity sides of A3, `npm run demo:swap` · still to do: a real EVM adapter (Anvil/Base), the NGO side, the quote board, the UI · builds on the donor agent (branch
`donor-agent`), the NGO/service agent (`agent/`) and the sCrypt escrow.*

**Why this matters for the track.** The adoption criterion (35%) asks for
apps that bring **new users and liquidity from other chains** to BSV. Today
CryptoPledgePot only works for people who already hold BSV. Most donors hold
stablecoins or ETH elsewhere, and most NGOs need stable value to pay real
suppliers. This plan makes the two agents into **on-ramps**:
- the donor agent brings a donor's assets **from another chain into their own
  BSV wallet** (or straight into a campaign's escrow);
- the NGO agent can **accept those donations**, and when needed **turn
  released sats back into stable value**.

Throughout, **non-custodial** means: at no point can an agent, CryptoPledgePot,
or a counterparty take the user's assets. Either the swap completes on both
chains, or each side gets its own money back after a timeout.

---

## 1. Options, and the recommendation

| Option | How it works | Custody | Fit |
|---|---|---|---|
| **A. Atomic swaps (HTLC)**: recommended first | Two hash-time-locked contracts, one per chain, tied to the same secret. Revealing the secret to claim on one chain lets the other side claim on the other chain; otherwise both refund after timeouts | **None.** The script guarantees "both or neither" | Reuses our sCrypt toolchain (same OP_PUSH_TX timelock as the escrow) and the agent loop. Needs a counterparty with liquidity, which is a third agent (§3) |
| B. Threshold-signature bridge (e.g. ICP chain-key, named in the track brief) | A decentralised signer network holds deposit addresses on both chains and mints a wrapped token (BSV-21) on BSV | Distributed: no single party, but you trust the signer network's security | Pooled liquidity and stablecoins *on* BSV. A large separate build (canister + overlay + escrow for tokens) |
| C. Exchange / custodial service | Deposit, sell, withdraw | **Custodial** | Rejected: fails the track's non-custodial requirement |

**Recommendation:** build **A** first. It is fully non-custodial, fits what we
already have, and can be demonstrated end to end with the agents. Keep **B**
as phase 2 for stablecoin-denominated campaigns once wrapped stablecoins exist
on BSV.

**First pair:** **USDC on Base ⇄ BSV** (cheap EVM fees, the stablecoin most
donors hold). The design generalises to other ERC-20s, other EVM chains, and
BTC (which has native HTLCs).

---

## 2. How an atomic swap works here

```
Donor (has USDC on Base)                 Liquidity agent (has BSV)                 BSV
───────────────────────────              ──────────────────────────               ───
1. donor agent asks for quotes  ──RFQ──▶  quote: 100 USDC → 2,150,000 sats, valid 60 s
2. donor approves (co-pilot) and picks a SECRET s, publishes H = sha256(s)
3. donor locks 100 USDC in an HTLC on Base:  pay LP if s is shown, else refund donor after T1 (e.g. 4 h)
                                    4. LP sees the lock (enough confirmations) and locks
                                       2,150,000 sats in an sCrypt HTLC on BSV:
                                       pay the DONOR'S BSV KEY if s is shown, else refund LP after T2 (e.g. 2 h, T2 < T1)
5. donor agent claims the sats on BSV by revealing s  ─────────────────────────────────────▶ sats in donor's BSV wallet
                                    6. LP reads s from the BSV transaction and claims the USDC on Base before T1
If anyone stops: the donor refunds the USDC after T1; the LP refunds the sats after T2.
```

Rules that make it safe, enforced in code:
- **T2 < T1, with a safety margin:** the party who reveals the secret (the
  donor) always has time to claim before the other side can refund.
- **Lock only after enough confirmations on the other chain,** with
  per-chain settings; BSV 0-conf is not enough for an LP accepting a
  cross-chain lock.
- **The claim goes to a key derived in the donor's own BRC-100 wallet**
  (BRC-42), never to an agent's key.
- **Amounts and hashes are verified on chain before every next step.** An
  agent never acts on a counterparty's message alone.

**Direct to escrow (one step for donors):** in step 4 the BSV-side HTLC can pay
to an **escrow output** for a chosen campaign instead of the donor's wallet.
Simpler for the donor, but it ties the swap to that campaign's terms.
Phase A3.

## 3. Roles: what each agent does

| Agent | New job | Mode |
|---|---|---|
| **Donor agent** (exists) | "Fund from anywhere": the donor states what they hold ("200 USDC on Base"). The agent collects quotes, picks the best **after due diligence on the counterparty** (its swap history, timelock terms, price vs. a reference), writes a memo, and in **co-pilot** asks the donor to approve both the EVM lock (their EVM wallet) and the claim (their BSV wallet). It watches both chains, claims, and refunds on timeout | Co-pilot first: the donor signs both chains. Autopilot later, only for assets already in the agent's own wallets |
| **NGO / service agent** (exists) | **Accept** "pledge with USDC" on its campaign (donor-side swap straight into escrow). **Pay out:** turn released sats back into USDC via the same HTLC, to pay suppliers in stable value. **Price** its pay-per-call purchases in stable terms | Its own wallets; policy limits in code (max swap size, max slippage) |
| **Liquidity agent** (new) | Market maker: holds BSV and USDC inventory, answers quotes (RFQ), runs its side of each HTLC, never holds user funds. Anyone can run one; agents compete on price, which is also the start of the track's "order book where agents trade" | Autopilot with strict inventory, price and exposure limits |
| **Quote board** (small server addition) | Collects signed quotes from liquidity agents and shows each LP's track record (completed / refunded swaps, read from both chains). It **never touches funds** and can be rebuilt from chain | Part of the CryptoPledgePot server |

## 4. Building blocks

**On BSV (we have the toolchain):**
- `contracts/src/contracts/atomicSwap.ts` (sCrypt): `claim(preimage, receiverSig)`
  when `sha256(preimage) == hash`; `refund(senderSig)` once `nLockTime ≥ T2`
  (OP_PUSH_TX, as in our escrow refund).
- `core/swap.ts`: template filler, parser, unlocking scripts, preimages,
  cross-checked byte for byte against scrypt-ts and run through the SDK
  interpreter for every path. This is the same method as `core/pledge.ts`.

**On EVM (new, kept small):**
- A minimal audited-pattern HTLC contract for ERC-20s (`lock`, `claim(secret)`,
  `refund` after T1), or an existing well-reviewed HTLC deployment.
- `viem` in the agents for reading and writing; the donor signs in their own
  EVM wallet (MetaMask, Coinbase Wallet) from the page.

**Shared protocol (`swap/`):**
- the swap state machine (quoted → locked-src → locked-dst → claimed → settled
  | refunded);
- signed RFQ/quote messages (BRC-103 identities for agents; EIP-191 for EVM
  addresses);
- chain watchers (Base RPC, WhatsOnChain/Arcade on BSV) with confirmation
  thresholds;
- a persistent journal, so a restarted agent resumes every open swap and never
  misses a refund window.

**UI:**
- **Donate page:** "Pledge with USDC" (quote, memo, two approvals, live
  status, refund if it stalls).
- **Donor agent page:** "Bring assets in" (balance on other chains, best
  route, history).
- **NGO dashboard:** "Pay out in USDC".

## 5. Phases

| Phase | What | Exit criteria | Effort |
|---|---|---|---|
| **A0 · Spike** | Pick the chain pair and the HTLC contract; check fees and confirmation times on Base Sepolia and BSV testnet | A one-page decision note with numbers | 0.5 d |
| **A1 · BSV HTLC** | The sCrypt `AtomicSwap` contract and `core/swap.ts` | Byte-for-byte cross-check; interpreter tests for claim, wrong secret, refund too early, refund after T2, wrong signer | 1 d |
| **A2 · Two-chain swap engine** | The `swap/` state machine, EVM HTLC (local Anvil chain), watchers, journal | E2E on Anvil + the BSV mock chain: a happy swap; the donor walks away (both refund); the LP walks away (both refund); a restart mid-swap resumes; the timeouts T2 < T1 are enforced | 2 d |
| **A3 · Agents** | Liquidity agent (RFQ, inventory limits); donor agent "fund from anywhere" (co-pilot); NGO agent "accept USDC into escrow" and "pay out in USDC"; quote board | E2E: a donor with only USDC ends up with an escrowed pledge; the NGO pays a supplier in USDC from released sats; every step has a memo; LP limits hold under 50 concurrent requests | 2 d |
| **A4 · UI** | The pages in §4, live status, refund buttons | Playwright (read-only, demo mode) plus a manual testnet run | 1 d |
| **A5 · Testnet, then mainnet** | Base Sepolia + BSV testnet with real wallets; then small mainnet swaps | Links to both chains for each step in `USAGE_AND_VALUE.md` | 1 d + waiting |
| **B · Wrapped stablecoins (later)** | A threshold bridge (e.g. ICP chain-key) minting BSV-21 USDC; **extend the BSV-21 overlay and escrow** so tokens can sit in milestone escrow (today the kit only admits inscription + P2PKH outputs) | Stablecoin-denominated campaigns end to end | 2–3 weeks |

**A total:** about 7–8 days. **Hackathon cut** (offline, fully demoable):
A1 + A2 + the donor side of A3 on Anvil and the mock chain, about 4 days.
That would add a third story to the demo: "a donor with only USDC backs
AirWatch".

## 6. Testing

- **The contract:** the same method as the escrow (byte-for-byte compiler
  cross-check, every spending path through the interpreter, negative cases).
- **Adversarial scenarios** in E2E tests:
  - an LP who never locks;
  - a donor who never claims;
  - a secret revealed late, near T2;
  - a reorg on the EVM side before the LP locks;
  - a quote with a wrong hash or amount;
  - an LP who locks less than quoted;
  - a front-run attempt on the revealed secret (the BSV claim pays a fixed
    donor key, so a copier can't redirect it);
  - an agent restarted at every state.
- **Safety in the harness:** no browser automation where a real wallet
  listens; demo and test modes use Anvil and the mock chain only.

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Timelock mistakes lose funds** | T2 < T1 with a margin enforced in code; the journal plus watchers make sure refunds happen; tests at every boundary |
| **No liquidity** | Our own liquidity agent seeded with a small inventory for the demo; open RFQ so others can join |
| **Price moves during the swap** ("free option") | Short quote validity; the LP locks only after the donor's lock confirms; the donor can decline before signing |
| **EVM confirmations / reorgs** | Per-chain confirmation thresholds before the counterparty locks |
| **Preimage front-running** | The BSV claim requires the receiver's signature and pays a fixed key |
| **Fees eat small swaps** | Minimum swap size per chain; Base keeps EVM fees low; quotes show all fees |
| **Stablecoin issuer risk** | USDC can be frozen by its issuer on its home chain; once swapped, the donor holds native sats. Stated plainly in the UI |
| **Regulation** | Swaps are peer-to-peer and non-custodial; the platform never holds or routes funds. Get advice before a public mainnet launch |

## 8. Decisions needed

1. **Start with A (atomic swaps), with B (a wrapped-stablecoin bridge)
   later?** Recommended.
2. **First chain pair:** USDC on Base ⇄ BSV?
3. **Hackathon cut:** about 4 days, offline (Anvil + mock chain), as a third
   demo story? Or go straight to testnets?
4. **Who seeds liquidity** for the demo and first mainnet swaps, and how much?
5. **Direct-to-escrow swaps** (A3) from the start, or "into the donor's
   wallet" first (simpler)?

# Bridging plan: real money from other chains, DeFi and CeFi into BSV

**What exists today.** The swap flow is built, but only half of it is real:

- `swap/` runs a full atomic swap (an HTLC on each side).
- The BSV half is **real**: the sCrypt `AtomicSwap` contract, cross-checked byte for byte, tested in the SDK interpreter and on the mock chain.
- The USDC half is **simulated** (`swap/usdcChain.ts`, `SimulatedUsdcChain`).

The design reasoning is in [`CROSS_CHAIN_PLAN.md`](CROSS_CHAIN_PLAN.md). This document is the plan to replace the simulation with real rails, one at a time, and to connect DeFi and CeFi sources without becoming custodial.

**The non-negotiable rule** (track requirement and AGENTS.md): user funds stay in the user's control.

- At no step may CryptoPledgePot, an agent, or a liquidity provider be able to take them.
- If a route cannot meet that rule, it is either rejected or labelled clearly as *the user's own custodial account*, used by the user, outside our app.

## 0. Why this can be real without a new bridge

Our hashlock is `sha256(secret)` (`core/swap.ts`, `hashlockOf`). The same 32-byte SHA-256 lock is native on every rail we care about:

| Rail | How sha256 hashlocks work there |
|---|---|
| BSV | `AtomicSwap` (built) |
| EVM (Base, Ethereum, Arbitrum, Polygon…) | `sha256()` is a precompile; a 60-line Solidity HTLC |
| Bitcoin on-chain | `OP_SHA256 <h> OP_EQUALVERIFY` in a P2WSH script |
| Lightning | The payment hash **is** `sha256(preimage)`: a hold invoice is an HTLC |

So one secret can tie a BSV lock to a lock on any of these rails. The
`SourceChain` interface in `swap/usdcChain.ts` (`account().lock/claim/refund`, `htlc(id)`, `now()`) is the seam: each rail is one adapter that implements it.

## 1. Sources and how each one gets in

| Source | Route into a BSV wallet or escrow | Custody | Phase |
|---|---|---|---|
| **USDC / USDT / ETH on an EVM L2** (Base first) | EVM HTLC ⇄ BSV `AtomicSwap`, with an LP agent on the other side | none (script-enforced) | 1 |
| **Any ERC-20 via DeFi** (e.g. a DAO treasury holding ETH) | The donor's own wallet swaps token → USDC on a DEX, in the **same tx** as locking the HTLC (a router call, then `lock`), then follows the Phase 1 path | none. The DEX is a contract, not a custodian | 2 |
| **Bitcoin on-chain** | P2WSH HTLC ⇄ BSV `AtomicSwap` | none | 3 |
| **Lightning** | The donor pays a hold invoice whose hash is our hashlock. The LP settles it only after the donor claims on BSV (submarine-swap style) | none, but needs an LP running a Lightning node | 3 |
| **CeFi: an exchange account the user owns** | The user withdraws BSV from their exchange **to an address from their own BSV wallet**. We only show a receive address and verify the payment with SPV | the exchange is custodial **for the user, by the user's choice**. We never touch credentials or API keys | 2 |
| **CeFi: a fiat on-ramp (card/SEPA)** | A licensed provider delivers BSV (or USDC, which then goes through Phase 1) to the user's own address | the provider is custodial until delivery. Mark it in the UI | 4 |
| **Wrapped stablecoins on BSV via a threshold bridge** (e.g. ICP chain-key, named in the track brief) | Mint a BSV-21 stablecoin. Campaigns denominated in it need a BSV-21 escrow variant | distributed signers (a trust assumption, not a single custodian) | 5, research |

**Provider facts are not assumed.** Before any provider (exchange, on-ramp, DEX, Lightning LSP or bridge) goes into the UI, check:

- that it currently supports BSV withdrawals or delivery to self-hosted addresses;
- that it serves the users' country;
- its fees.

Record the check, with the date, in this file. Exchange support for BSV changes over time.

## 2. Phase 1: a real EVM HTLC (Anvil → Base Sepolia → Base)

**Contract** (`evm/contracts/HashedTimelock.sol`, Foundry project):

```solidity
// lock(receiver, token, amount, hashlock, refundAfter) -> id   (pulls the ERC-20 with transferFrom)
// claim(id, secret)   requires sha256(abi.encodePacked(secret)) == hashlock, block.timestamp < refundAfter, msg.sender == receiver
// refund(id)          requires block.timestamp >= refundAfter, msg.sender == sender
// events: Locked(id, ...), Claimed(id, secret), Refunded(id)
```

- `id = keccak256(sender, receiver, token, amount, hashlock, refundAfter, nonce)`.
- Use OpenZeppelin `SafeERC20`. No owner and no admin. Not upgradeable.
- The secret is 32 bytes exactly, matching `newSecret()`.

**Adapter** (`swap/evmChain.ts`, implements `SourceChain` with **viem**):

- `lock`, `claim`, `refund` → `writeContract`, then wait for the receipt.
- `htlc(id)` → read the contract storage. The secret comes from the `Claimed` event logs (that is how the LP learns it).
- `now()` → the latest block's timestamp, not the local clock.
- Confirmations: the LP only treats a lock as real after `N` blocks (config, default 3 on Base). This is the reorg defence from AGENT_TEST_PLAN S10.
- The donor's EVM key stays in the donor's EVM wallet. In the browser, that is EIP-1193 (`window.ethereum`) through viem's `custom()` transport. In Node, it is a test key from env, **testnet only**.

**Steps:**

1. Anvil (local): deploy the contract and a mock USDC (6 decimals). Run `swap.e2e` with `evmChain` instead of `SimulatedUsdcChain`. All 5 existing cases must pass unchanged.
2. Foundry unit tests for the contract: wrong secret, a 31/33-byte secret, a claim after the timeout, a refund before it, a double claim, a refund by a stranger, a fee-on-transfer token (refused by checking the balance delta).
3. Base Sepolia: deploy. Use Circle's testnet USDC from their faucet (verify the current address in Circle's docs). Do one swap against **BSV mainnet with tiny amounts** (BSV has no practical public testnet for our wallet stack; 1,000 sats is a few cents). Record both txids.
4. Contract review: a second team member reads it line by line. Run `slither`. No mainnet deploy without this.
5. Base mainnet: cap each swap at 20 USDC in the LP config (`maxUsdc`). Run the end-to-end flow with a team wallet: USDC → sats → straight into a campaign escrow (`donorSwap.ts` already pledges the claimed sats).

**Timeouts:** T1 (the EVM refund time) ≥ T2 (the BSV refund time) + safety margin. Defaults: T1 = now + 6 h, T2 = now + 3 h, margin 2 h. They are already enforced by `minSourceWindow` and `safetyMargin` in `liquidityAgent.ts`.

## 3. Phase 2: DeFi sourcing and CeFi withdrawals

- **DEX:** in the donor UI, if the donor holds token X instead of USDC, get a quote from a DEX aggregator or Uniswap's router on Base. Build one tx (a multicall) that swaps X → USDC and calls `lock`. The aggregator's API is only a quote source. The tx is signed by the donor's wallet, and the slippage limit is in the calldata. If the swap fills below the limit, the whole tx reverts, so nothing is locked.
- **CeFi withdrawal helper:** a "Fund from an exchange" panel.
  - It asks the donor's BRC-100 wallet for a **derived-key** receive address (BRC-29 style, never `P2PKH(identityKey)`).
  - It shows the address as a QR code, then polls WhatsOnChain/Arcade until a payment arrives.
  - It verifies the payment with SPV and internalizes it with `'wallet payment'`.
  - We store no exchange credentials and call no exchange API.

## 4. Phase 3: Bitcoin and Lightning

- **BTC:** a P2WSH HTLC script (`OP_IF OP_SHA256 <h> OP_EQUALVERIFY <lp_pk> OP_ELSE <T1> OP_CHECKLOCKTIMEVERIFY OP_DROP <donor_pk> OP_ENDIF OP_CHECKSIG`).
  - Build it with `bitcoinjs-lib`, signet first.
  - The donor signs with their own BTC wallet through a PSBT. We never hold a BTC key.
  - The LP watches through a public Esplora API, with 2 confirmations.
- **Lightning:** the LP runs a node that supports hold invoices (e.g. LND `AddHoldInvoice`).
  1. The donor pays the invoice. Nothing settles.
  2. The LP locks sats on BSV with the same hash.
  3. The donor claims on BSV, which reveals the secret.
  4. The LP settles the invoice with that secret.

  If the donor never claims, the invoice is cancelled and the funds return automatically. The invoice expiry must be longer than T2 + the margin.

## 5. Phase 4–5: fiat on-ramp and wrapped stablecoins

- **On-ramp:** embed a provider's widget configured with the user's own receive address (BSV, or USDC on Base followed by Phase 1). The UI says plainly that the provider holds the money until delivery and handles KYC.
- **Threshold bridge / BSV-21 stablecoins:** research only until a production bridge with audited contracts exists. It would need:
  - a BSV-21 variant of the escrow (it tracks the token amount instead of sats; the overlay is the source of truth, per AGENTS.md);
  - campaigns denominated in a stablecoin.

## 6. Liquidity: who is on the other side

- The **liquidity agent** (`swap/liquidityAgent.ts`) is the LP. At first it is a team-run instance with a small float (e.g. 50 USDC and the sats equivalent), published limits, and a public quote endpoint.
- **Price:** quotes come from a public BSV/USD price (the median of 2–3 sources), plus a spread (e.g. 1 %). A quote is valid for 120 s (already in the code).
- **Inventory risk:** the LP rebalances by hand at first. The exposure cap (`maxUsdc`, `openExposure`) bounds the loss.
- **Later:** several LP agents post quotes to a quote board (a BRC-87 topic such as `tm_swap_quotes`), and the donor agent picks the best one. Many LPs means no single point of failure.

## 7. Risks and how each is handled

| Risk | Mitigation |
|---|---|
| A bug in the HTLC contract loses funds | Foundry tests, slither, a second reviewer, a 20 USDC cap per swap, no admin keys |
| The LP sees the secret too late (claims after T1) | T1 − T2 ≥ 2 h margin. The LP watcher runs every minute and claims on restart (S4) |
| A reorg on the source chain | Wait N confirmations before locking sats |
| The donor's EVM wallet signs a malicious tx | The UI shows the decoded call (contract, amount, hashlock, timeout) before signing |
| Price moves between quote and lock | Quote expiry. The LP refuses expired quotes |
| A DEX swap fills badly | Slippage limit in calldata. The tx reverts, nothing is locked |
| Provider stops supporting BSV | Provider list re-checked and dated. No hard dependency on any CeFi provider |
| Front-running a claim on EVM (the secret becomes public in the mempool) | Only the `receiver` can claim, so seeing the secret does not help an attacker |

## 8. Compliance (not legal advice)

- **Atomic swaps:** the user swaps with an LP through scripts, and we never hold funds. That is the strongest non-custodial position.
- **A team-run LP** that exchanges crypto for other people as a business may count as a crypto-asset service under MiCA in the EU (we are in Germany). Before running an LP for the public beyond a hackathon demo, get legal advice. Until then, the LP runs only with team money, for demos.
- **CeFi and on-ramp** KYC is the provider's job. We store no personal data from those flows.

## 9. Tests for every phase

Every adapter must pass the **same** `swap.e2e` suite that the simulation passes today. Each phase adds its own tests:

| Phase | Tests |
|---|---|
| 1 | Foundry contract tests; `swap.e2e` on Anvil; S1–S10 from AGENT_TEST_PLAN on Anvil; a manual Base Sepolia ⇄ BSV run with recorded txids |
| 2 | DEX: slippage revert, approval missing, a token with fees. CeFi helper: wrong amount, two payments, a payment to an old address |
| 3 | BTC on signet: claim, refund, CLTV too early. Lightning on regtest (Polar): settle, cancel, invoice expiry < T2 refused |
| 4–5 | Manual, provider sandbox |

## 10. Order and size

| Phase | Deliverable | Effort |
|---|---|---|
| 1a | EVM HTLC + Foundry tests + `evmChain.ts` on Anvil | 1–2 days |
| 1b | Base Sepolia + a real BSV leg, txids in USAGE_AND_VALUE | 0.5 day |
| 1c | Review, Base mainnet with a 20 USDC cap | 0.5 day + review |
| 2 | DEX multicall + the "Fund from an exchange" panel | 2 days |
| 3 | BTC signet HTLC, then Lightning hold invoices | 3–4 days |
| 4–5 | On-ramp widget; BSV-21 escrow research | open |

For the hackathon, Phase **1a + 1b** is the realistic target. It turns "simulated USDC" into "real USDC on a public testnet, real sats on BSV mainnet", which is the honest claim judges can check.

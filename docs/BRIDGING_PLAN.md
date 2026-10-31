# Bridging plan: real money from other chains, DeFi and CeFi into BSV

**Status (30 Oct 2026): Phase 1a happy path built.** The swap now runs against a **real EVM contract**, not only the simulated ledger:

- `evm/contracts/HashedTimelockERC20.sol` (Solidity 0.8.38, compiled into `evm/artifacts.json` by `npm run evm:compile`);
- `swap/evmChain.ts`, a viem adapter that implements `SourceChain`;
- `swap/anvil.ts`, which starts a local EVM chain (Foundry's Anvil, from the `@foundry-rs/anvil` npm package);
- `npm run demo:bridge`, which runs USDC on a local EVM chain → sats in the donor's own BSV wallet → a pledge;
- `npm run evm:deploy`, which deploys the HTLC (tested against Anvil);
- `test/bridge.evm.test.ts`, with 3 tests: the happy path, the refund path, and the contract refusing a wrong secret, a stranger, or a second claim.

The BSV side still runs on the offline mock chain, and nothing has run on a public chain yet. What is left is listed in the [TBD list](#tbd-after-the-happy-path) at the end.

**What existed before.** The swap flow was built, but only half of it was real:

- `swap/` runs a full atomic swap (an HTLC on each side).
- The BSV half is **real**: the sCrypt `AtomicSwap` contract, cross-checked byte for byte, tested in the SDK interpreter and on the mock chain.
- The USDC half was **simulated** (`swap/usdcChain.ts`, `SimulatedUsdcChain`). The simulation is still used by `demo:swap` and `swap.e2e`.

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

- **BTC: happy path done, on a real Bitcoin Core 32.1 node (regtest).**
  - **The script:** a P2WSH HTLC, `OP_IF OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <h> OP_EQUALVERIFY <lp_pk> OP_ELSE <T1> OP_CHECKLOCKTIMEVERIFY OP_DROP <donor_pk> OP_ENDIF OP_CHECKSIG`.
  - **The code:**
    - `swap/btc.ts` builds it with no Bitcoin library: the script, BIP 143 sighash, low-S DER, segwit serialization and bech32.
    - `swap/btcChain.ts` is a `SourceChain` over bitcoind RPC, so `LiquidityAgent` and `DonorSwap` run unchanged.
  - **The HTLC id:** `txid:vout:witnessScript`. It is self-verifying: the reader checks that the output pays sha256(script) and reads the terms from the script.
  - **Funding:** the donor funds the HTLC by paying its bech32 address from their own Bitcoin wallet (the `funder`). Their key is only used to sign a refund.
  - **Run it:** `npm run demo:bridge:btc`. The tests are `bridge.btc`.
  - **What the tests check:**
    - the full swap, and the agent waiting for 1 confirmation;
    - a lock for the wrong amount is rejected, and the donor gets the BTC back after T1;
    - bitcoind itself refuses an early refund (non-final), a wrong secret, and a claim signed with the wrong key;
    - mutation check: a wrong sighash fails both swap tests.
  - **The difference from the EVM version:** nothing on chain stops a claim after T1, so the LP must claim well before it (it claims right after the donor's BSV claim).
  - **Backends:**
    - `BitcoindBackend`: your own node, with `-txindex`;
    - `EsploraBackend`: mempool.space or blockstream, on mainnet, signet or testnet. Checked live (read-only) against mempool.space: outputs, confirmations, the outspend witness, median time and fee estimates.
  - **Fees** are estimated from the backend's rate × the spend's real vsize, with a 2 sat/vB floor.
  - **`npm run lp`** takes `BRIDGE_CHAIN=btc|btc-signet|btc-testnet|btc-regtest`. I started it against a regtest node with a throwaway wallet: it serves `/api/lp` with the BTC asset and refuses quotes until it holds BSV.
  - **Still open:**
    - a funded signet or mainnet run;
    - PSBT signing in a browser wallet.
  - **Checked before use:** the binary is checked against `SHA256SUMS`, and `SHA256SUMS.asc` carries 8 good builder signatures. It lives in `~/opt/bitcoin-32.1`; `BITCOIND_BIN` overrides that.
- **Lightning:** the LP runs a node that supports hold invoices (e.g. LND `AddHoldInvoice`).
  1. The donor pays the invoice. Nothing settles.
  2. The LP locks sats on BSV with the same hash.
  3. The donor claims on BSV, which reveals the secret.
  4. The LP settles the invoice with that secret.

  If the donor never claims, the invoice is cancelled and the funds return automatically. The invoice expiry must be longer than T2 + the margin.

  **Happy path done, on real LND 0.21.6 nodes (regtest).**
  - **The code:**
    - `swap/lightningChain.ts` is a `SourceChain` over LND REST;
    - `swap/lnd.ts` is the REST client with a pinned TLS certificate, plus throwaway regtest nodes and a channel helper.
  - **Interface changes:** two optional hooks, so the agents stay chain-agnostic.
    - `SourceChain.request`: the receiver acts first, by issuing the hold invoice under the donor's hashlock. The agent exposes it as `sourceRequest` and `POST /api/lp/request`.
    - `SourceAccount.release`: when the agent refunds its sats, it cancels the invoice, so the donor is paid back at once.
  - **Before paying, the donor checks the invoice:** the hash, the amount, the payee and the timeout.
  - **Tests** (`bridge.lightning`, 4 tests):
    - the happy path;
    - a wrong-amount invoice is refused, and a cancelled invoice fails back;
    - the donor never claims: the agent refunds its sats and cancels the invoice;
    - the same swap through the HTTP service.
    - Mutation check: without the donor's amount check, the refusal test fails.
  - **Run it:** `npm run demo:bridge:ln`, or `npm run lp` with `BRIDGE_CHAIN=ln` and the agent's own LND.
  - **Any wallet:** a donor needs no Lightning node of their own.
    - `swap/bolt11.ts` decodes the invoice without a library and recovers the payee from its signature. It matches the BOLT 11 spec example, and LND's own decoding of real invoices.
    - `swapLightningToSats` (`swap/browserLightning.ts`) checks the hash, amount, payee and timeout locally, then pays through a `payer` callback (`weblnPayer` for browser wallets such as Alby).
    - It is tested end to end over HTTP against real LND nodes.
  - **Still open:**
    - a real-network run;
    - routing through other nodes (tested only on a direct channel);
    - the case where the agent disappears and the HTLC expires on chain (LND handles it; not exercised here).
  - **Checked before use:** the LND binary in `~/opt/lnd-linux-amd64-v0.21.6-beta`. Its checksum is in the release manifest, and the manifest carries 3 good maintainer signatures.

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
| 1a | EVM HTLC + `evmChain.ts` on Anvil: **happy path done**; the full edge-case suite is in the TBD list | 3–4 days in total (revised from 1–2) |
| 1b | Base Sepolia + a real BSV leg, txids in USAGE_AND_VALUE | 0.5 day |
| 1c | Review, Base mainnet with a 20 USDC cap | 0.5 day + review |
| 2 | DEX multicall + the "Fund from an exchange" panel | 2 days |
| 3 | BTC signet HTLC, then Lightning hold invoices | 3–4 days |
| 4–5 | On-ramp widget; BSV-21 escrow research | open |

For the hackathon, Phase **1a + 1b** is the realistic target. It turns "simulated USDC" into "real USDC on a public testnet, real sats on BSV mainnet", which is the honest claim judges can check.

## TBD after the happy path

What the Phase 1a happy path does **not** do yet, in rough order:

- [ ] **The real BSV leg.** The demo's BSV side is the mock chain. Run the BSV half on mainnet with tiny amounts (needs team sats) and record the txids.
- [ ] **Base Sepolia run.** Deploy with `npm run evm:deploy`, then run `npm run demo:bridge` with `BRIDGE_RPC_URL` and the other env vars. The public-chain code path exists but is **untested**: it needs funded testnet accounts. Check Circle's docs for the current test-USDC address.
- [x] **Persisted LP state** (S4). The swaps are saved in a file store; `bridge.service` crashes and restarts the agent mid-swap, and it still collects. A crash between broadcasting the BSV lock and saving it is recovered from the wallet's swap basket. The donor fetches a recovered lock or a lost reply via `GET /api/lp/swaps/:quoteId`.
- [x] **The LP as its own service.** `npm run lp` (HTTP: status, quote, lock), with `LiquidityClient` for donors. Both implement `LiquidityProvider`.
- [x] **One source lock, one swap** (S5). This was a real hole, now fixed (`swap.edges`).
- [x] **Confirmations before locking sats** (S10). Done: `minSourceConfirmations` (default 3 in `npm run lp`); until then the agent answers "wait:" instead of refusing.
- [x] **Edge cases on Anvil.** Covered on the real EVM contract: the happy path, an expired quote, the donor never claiming (both sides refund), a short-changing agent (refused, refunded), confirmations, the contract's own refusals, a crash and restart, and a lost reply.
- [ ] **Contract hardening.** Still open: a second human reviewer, and a Foundry fuzz pass. Done: a Slither 0.11.6 pass (see DEVLOG 9.6): a reentrancy guard was added on every external function, and tokens' revert reasons now pass through. Done: `bridge.contract` tests that a fee-on-transfer token (mutation-checked: fails without the balance-delta check), a 0 amount, a `refundAfter` now or in the past, and the 0 receiver are all refused.
- [x] **Donor signs in their own EVM wallet.** `swap/browserEvm.ts` `connectBrowserEvm(window.ethereum, …)` gives an `EvmUsdcChain` whose transactions and permit are signed by the wallet (EIP-1193; it asks the wallet to switch chains, and stops if refused). Tested against Anvil through an EIP-1193 shim, with no donor key in the process. The **Bring USDC** page (`#/bring-usdc`) uses it through `swap/browserSwap.ts` (`swapUsdcToSats`, tested end to end). The page is configured with `VITE_LP_URL`, `VITE_EVM_RPC_URL`, `VITE_EVM_HTLC`, `VITE_EVM_TOKEN` and `VITE_EVM_CHAIN`, and has not been clicked through with real wallets.
- [x] **One transaction instead of two.** `lockWithPermit` + `EvmUsdcChain({ permit: true })`: an EIP-2612 permit replaces `approve` (tested: 1 transaction vs 2). Off by default; on for real USDC once tested on a testnet.
- [x] **Docker.** `demo:bridge` runs in the `app` image (built with Podman, run with `podman run … npm run demo:bridge`): the image keeps dev dependencies, which include the Linux anvil binary.
- [x] **Phase 2, CeFi part: "Fund from an exchange".** `client/receive.ts` plus a Dashboard panel: a fresh BRC-29 deposit address (counterparty "anyone", never the identity key), and "Check for payment" (WhatsOnChain), which verifies and internalizes the payment into the user's own wallet. Tested on the mock chain (`receive.test`). Not yet tried with a real exchange withdrawal; check the exchange's BSV support.
- [x] **Phase 2, DeFi part: DEX sourcing in one transaction.**
  - `SwapAndLock.sol` is a stateless router: it swaps another token on a DEX and locks exactly the quoted USDC through `HashedTimelockERC20.lockFor` (refundable to the donor), returns any surplus, and reverts on slippage.
  - It refuses a "DEX" that is the HTLC or one of the tokens. Arbitrary calls never run in the HTLC, which holds everyone's locks.
  - `EvmUsdcChain.swapAndLock`, and `DonorSwap.lockAndRequest(…, lockWith)`.
  - Tested on Anvil with a fixed-rate `TestDex` (`bridge.dex`). **Real DEX:** `swap/dex.ts` builds Uniswap V3 `exactInputSingle` calldata. On a **fork of Base** (`FORK_URL=https://mainnet.base.org npx vitest run test/bridge.fork.test.ts`), real ETH becomes real WETH, then real USDC via the real Uniswap router, and exactly 20 USDC are locked. Real USDC's permit works too.
- [x] **BTC on-chain (Phase 3a):** the happy path and the refund work on a Bitcoin Core regtest node; see §4.
- [ ] **BTC on signet or mainnet:** the code is ready (Esplora backend, fee estimation, `npm run lp` with `BRIDGE_CHAIN=btc-signet`). It needs a funded signet key (`LP_BTC_KEY`) and BSV inventory.
- [x] **Lightning (Phase 3b):** hold-invoice swaps work on real LND nodes (regtest); see §4.
- [ ] **Lightning on a real network:** needs an LND node with inbound liquidity (`BRIDGE_CHAIN=ln`).
- [x] **A web page for the Lightning swap:** `#/bring-btc` (set `VITE_LP_LN_URL`). A WebLN wallet pays by itself; otherwise the page shows the checked invoice to pay from any wallet. The app builds, but the page has not been clicked through with real wallets.
- [ ] **On-ramp and wrapped stablecoins (Phases 4–5):** not started; they need provider research and accounts.

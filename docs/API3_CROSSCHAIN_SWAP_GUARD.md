# API3 price guard for the USDC → BSV swap

**Track:** API3, *"Real-world data. Checked by your contract."*

**In one sentence:** when a donor swaps USDC on an EVM chain for satoshis on
BSV, the Solidity contract that locks the USDC first checks the swap rate.
It compares it with a BSV/USD price signed by an Airnode on API3 AirnodeHub,
and refuses the lock if the rate is more than 2% off or the data is stale.

| | |
|---|---|
| Contract | [`evm/contracts/PriceGuardedHTLC.sol`](../evm/contracts/PriceGuardedHTLC.sol) (extends [`HashedTimelockERC20.sol`](../evm/contracts/HashedTimelockERC20.sol)) |
| API3 libraries (unchanged, MIT) | [`evm/contracts/api3/`](../evm/contracts/api3/): `AirnodeV2Attestation`, `ProjectedJson`, `IsoTimestamp` from [airnodehub-hackathon-starter](https://github.com/api3dao/airnodehub-hackathon-starter) @ `52933ae` |
| Data source | CoinPaprika's Airnode on AirnodeHub, `getTickersById` for `bsv-bitcoin-sv` in USD. It is paid with x402: 0.001 aUSD on Base Sepolia |
| TypeScript | [`swap/api3Price.ts`](../swap/api3Price.ts) (request hash, fetch, verify, test signing) · [`swap/evmChain.ts`](../swap/evmChain.ts) (viem adapter, `lockWithPrice`) · [`swap/liquidityAgent.ts`](../swap/liquidityAgent.ts) (quotes from the signed price) |
| Tests | [`test/api3.guard.evm.test.ts`](../test/api3.guard.evm.test.ts): 9 tests on a real EVM chain (Anvil), including a **real API3 signature** |

---

## 1. The problem it solves

CryptoPledgePot lets donors who hold **only USDC on another chain** give to
BSV campaigns. They do this through an atomic swap with a *liquidity agent*
(an AI agent that holds BSV):

1. **Quote:** the agent quotes, for example, "100 USDC → 1,990,000 sats".
2. **Lock USDC:** the donor locks 100 USDC in an HTLC on the EVM chain, under
   `sha256(secret)`.
3. **Lock sats:** the agent locks the sats on BSV under the same hash.
4. **Claim sats:** the donor claims the sats with the secret, which reveals it.
5. **Claim USDC:** the agent claims the USDC with that secret.

Hash locks make this **non-custodial**: either both sides pay or both refund.
But they say nothing about **whether the rate was fair**. An agent with a
manipulated or plain greedy price could quote 1,500,000 sats instead of
2,000,000, and the swap would still be "atomic".

Off-chain checks don't really fix this. They live in the donor's app, which
the donor must trust, and they use whatever price source that app happens
to call.

**With the guard, the contract itself checks the rate.** A quote that is too
far from the market cannot lock the donor's USDC at all, whoever built the
transaction.

## 2. How the contract verifies API3 data on chain

AirnodeHub serves APIs through **Airnode v2**. Every response is signed with
EIP-191 over:

```
keccak256( requestHash ‖ timestamp ‖ data )
```

`PriceGuardedHTLC.lockWithPrice(receiver, token, amount, hashlock, refundAfter, quotedSats, timestamp, data, signature)`
runs these checks before any token moves:

| # | Check | Code | Refused with |
|---|---|---|---|
| 1 | **Signer:** the response was signed by the Airnode stored at deployment (CoinPaprika's `0xB8b7…f732`) | `AirnodeV2Attestation.verify(airnode, requestHash, …)` | `NotSignedByAirnode` |
| 2 | **Request:** it answers *the* stored request (BSV, in USD, with our projection), not BTC or another field. The stored hash goes into the signature check, so any other request recovers a different signer | same call, with the **stored** `requestHash` | `NotSignedByAirnode` |
| 3 | **Integrity:** `data` is byte for byte what was signed; changing one digit breaks the signature | same call | `NotSignedByAirnode` |
| 4 | **Fresh response:** signed at most `maxResponseAge` ago (5 min). The signature covers the timestamp, so it cannot be faked | `timestamp + maxResponseAge < block.timestamp` | `ResponseTooOld` |
| 5 | **Fresh price:** the observation itself is at most `maxPriceAge` old (15 min) and not from the future. A fresh signature can carry an old price | `ProjectedJson.readTimestamp(data, "updatedAt")` | `PriceTooOld`, `PriceFromTheFuture` |
| 6 | **Fair rate:** the quoted sats are within ±`maxDeviationBps` (200 = 2%) of `fairSats = amount / 10^6 USD ÷ price × 10^8` | `fairSats`, `withinTolerance` | `RateOutsideTolerance(quoted, fair, bps)` |

**The response projection** is part of the request hash. It cuts CoinPaprika's
ticker down to exactly two fields, so the contract knows the shape of `data`:

```json
{"price":17.452224207521592,"updatedAt":"2026-10-31T01:50:20Z"}
```

`ProjectedJson.readUint(data, "price", 18)` turns the price into an 18-decimal
integer, without floating point.

**After a successful lock** the contract stores what it checked in
`priceChecks[id]` (quoted sats, fair sats, price, price time) and emits
`PriceChecked`. Anyone can audit every swap's rate later from the chain.

**There is no way around it:**
- The inherited, unchecked `lock()` reverts with `UseLockWithPrice`.
- There is no owner or admin, and no setter. Airnode, request hash and
  tolerances are `immutable`, fixed at deployment.

**Anyone may submit the signed response:** the donor's agent, the liquidity
agent or a keeper. The contract trusts the signature, not the sender.

## 3. The flow with the guard

```
Liquidity agent                         API3 AirnodeHub (CoinPaprika Airnode)
  quote(100 USDC)
    ├── POST getTickersById(bsv-bitcoin-sv, USD) + projection ──▶ 402 → pays 0.001 aUSD (x402, Base Sepolia)
    │◀── { timestamp, data: {"price":…,"updatedAt":…}, signature } (signed)
    └── sats = 100 / price × 1e8 × (1 − spread 0.5%)  → Quote { sats, priceProof }

Donor (DonorSwap)                        EVM chain: PriceGuardedHTLC
  lock({ …, quotedSats, priceProof }) ──▶ lockWithPrice(…, quotedSats, timestamp, data, signature)
                                            1–5 verify signer, request, integrity, freshness
                                            6   |quotedSats − fairSats| ≤ 2 %  ──✗──▶ revert, USDC never move
                                            ✓   lock USDC, store priceChecks[id], emit PriceChecked
  … the atomic swap continues as before (agent locks sats on BSV, donor claims, agent claims USDC).
```

**Why the agent fetches the price:**
- the agent pays the 0.001 aUSD;
- its quote is derived from that same signed price, so an honest quote always
  passes;
- the donor's agent only passes the proof on.

A donor who distrusts the agent's proof does not have to rely on it. The
contract accepts **only** the stored Airnode's signature, so a proof the agent
made up fails check 1.

## 4. Design decisions

- **Signed responses (AirnodeHub), not a push feed.**
  - This is the hackathon's "from API to contract" flow.
  - API3's free first-party Nodary feeds have **no BSV/USD**. We checked:
    `/BSV~1USD/value` does not exist.
  - The AirnodeHub resolver lists CoinGecko and CoinPaprika for "USD price of
    BSV". CoinPaprika is cheaper and includes `last_updated`, so the contract
    can check the price's own age.
- **Both directions.** A quote far *below* the market cheats the donor. One
  far *above* means bad or manipulated data on one side. Neither should lock
  funds.
- **USDC = 1 USD (stated assumption).**
  - The contract values the stablecoin at 1 USD and checks only BSV/USD.
  - A second signed response (Nodary's free, first-party USDC/USD) could add a
    depeg check. The contract already reads Nodary's time format
    (`priceTimeFormat = UnixMillis`).
- **The libraries are copied, not rewritten.** `AirnodeV2Attestation`,
  `ProjectedJson` and `IsoTimestamp` are copied unchanged from API3's starter.
  They compile with OpenZeppelin 5.6.1 and Solady 0.1.26 from `evm/`'s own
  dependencies, the same as the starter's Foundry remappings.
- **Tolerances:** 2% rate, 5 min response age, 15 min price age.
  - CoinPaprika refreshes every few minutes.
  - A swap's USDC lock happens within the quote's 2-minute validity.
  - All values are constructor arguments.

## 5. Tests (`npx vitest run test/api3.guard.evm.test.ts`)

The tests run on Foundry's Anvil, a real EVM, with the compiled contract,
driven through the same viem adapter the app uses.

| Test | What it proves |
|---|---|
| Fair quote (−1%) locks | Correct `fairSats` math. `priceChecks` stores quoted 495,000,000 vs fair 500,000,000 sats at $20 |
| −3% refused | `RateOutsideTolerance`: the donor is protected |
| +3% refused | Two-sided tolerance |
| Stale response, stale price | `ResponseTooOld` and `PriceTooOld`, even though the signature is valid |
| Wrong signer · other request · tampered price | All three give `NotSignedByAirnode`. Editing `"price":20` to `10` breaks the signature |
| Plain `lock()` | `UseLockWithPrice`, so there is no bypass. The adapter also refuses to send a guarded lock without a proof |
| **A real API3 signature** | A response that **Nodary's Airnode actually signed** (fixture `test/fixtures/api3-nodary-usdc-usd.json`) is accepted by `checkedPrice`. The chain starts at the response's time, so it is fresh. Our `deriveRequestHash` equals the hash the Airnode reported. One changed byte gets it refused |
| Swap, honest agent | The agent quotes from a signed price with a 0.5% spread, the contract accepts, and the donor gets the sats on BSV |
| Swap, greedy agent (5% spread) | The contract refuses, and the donor's USDC balance is unchanged |

The local tests sign responses with a test key that is deployed as the
contract's `airnode`. That is the only way to make up prices and stale or
foreign responses on purpose. The real-signature test covers genuine API3
data.

## 6. Run it

```bash
# Tests (Anvil comes from the @foundry-rs/anvil dev dependency)
npx vitest run test/api3.guard.evm.test.ts

# The request the contract accepts and its hash; with a testnet payer key, a live signed BSV/USD price
npm run api3:price
API3_PAYER_KEY=0x… npm run api3:price     # Base Sepolia key holding aUSD (AirnodeHub faucet); pays 0.001 aUSD

# Recompile after changing a contract (installs evm/'s OpenZeppelin + Solady first)
npm run evm:compile

# Deploy the guarded HTLC (testnets only)
BRIDGE_PRICE_GUARD=api3 BRIDGE_RPC_URL=https://sepolia.base.org BRIDGE_DEPLOYER_KEY=0x… npm run evm:deploy
```

**Testnet funds:**
- aUSD for AirnodeHub calls:
  [AirnodeHub faucet](https://api3dao.github.io/airnodehub-hackathon/faucet/).
  The payer needs no ETH, because the x402 facilitator submits the transfer.
- Test USDC: [Circle faucet](https://faucet.circle.com).
- ETH for gas on Base Sepolia.

## 7. Status, honestly

- ✅ The contract, its checks and the swap with the guard pass on a real
  local EVM chain.
- ✅ A real API3-signed response passes the same verification code.
- ✅ The request PriceGuardedHTLC uses is accepted by CoinPaprika's live
  Airnode: it answers `402 Payment Required`. An invalid one gets `400`.
- 🟡 **Not run yet:**
  - a paid live fetch (needs a Base Sepolia key with aUSD);
  - a deployment on Base Sepolia.

  The commands are above. The code paths are the same as in the tests: only
  the RPC URL and the Airnode address change.
- 🟡 The adapter signs with local keys (tests, demo). In a browser, the
  donor's own EVM wallet would sign, as for the rest of the bridge
  (`docs/BRIDGING_PLAN.md`).

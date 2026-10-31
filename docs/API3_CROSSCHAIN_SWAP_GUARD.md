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
| Tests | [`test/api3.guard.evm.test.ts`](../test/api3.guard.evm.test.ts): 9 tests on a real EVM chain (Anvil), including a **real API3 signature** · [`test/api3.proof.evm.test.ts`](../test/api3.proof.evm.test.ts): the judges' proof (deployment record, tamper test) |
| **Check it yourself** | [Section 0](#0-proof-for-judges-check-it-yourself): every API3 requirement and its proof, the deployed address, your own signed responses, the tamper test |

---

## 0. Proof for judges: check it yourself

### 0.0 Every API3 requirement, and where its proof is

From the track's qualification requirements and "What to submit"
([hackathon.tum-blockchain.com/prizes#api3](https://hackathon.tum-blockchain.com/prizes#api3)):

| Requirement | Status | Where |
|---|---|---|
| AirnodeHub is essential to a core workflow; removing it must impair the app | ✅ | The USDC → BSV swap's lock **is** the price check: `lockWithPrice` is the only way in (`lock()` reverts), and the liquidity agent quotes from the same signed price. Without AirnodeHub no donor from another chain can lock funds. [§1](#1-the-problem-it-solves), [§3](#3-the-flow-with-the-guard) |
| A deployed contract verifies the expected signer, the intended request and timing | ✅ code · 🟡 **deployment pending** | Checks 1–5 in [§2](#2-how-the-contract-verifies-api3-data-on-chain); address and network in [0.1](#01-deployed-contract) once deployed |
| A value bound to the exact signed response drives an on-chain action | ✅ | The signed price → `fairSats` → the lock goes through or reverts; what was checked is stored in `priceChecks[id]` and emitted as `PriceChecked` ([§2](#2-how-the-contract-verifies-api3-data-on-chain)) |
| Protection against duplicate execution | ✅ | A swap's hashlock can lock only once (`HashlockAlreadyUsed`); test in `test/api3.proof.evm.test.ts` |
| **Deployed contract address and network** | 🟡 pending | [0.1](#01-deployed-contract) and `deployments/api3-price-guard.json` |
| **A way for judges to submit their own responses** | ✅ | `npm run api3:judge` with your own response files, or live; or the explorer's *Read contract* tab ([0.2](#02-submit-your-own-responses)) |
| **Tamper test in the video: one valid, four rejected** | ✅ tool and tests · 🟡 video and Base Sepolia run pending | [0.3](#03-the-tamper-test-one-valid-four-rejected); clip in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md) |
| **Description: who relies on the data, what goes wrong if forged, data we could not find** | ✅ text ready | [0.4](#04-for-the-devfolio-description) |

### 0.1 Deployed contract

| | |
|---|---|
| Network | Base Sepolia (chain id 84532) |
| `PriceGuardedHTLC` | _pending deployment: `npm run evm:deploy` writes it to `deployments/api3-price-guard.json`_ |
| Deploy transaction | _pending_ |
| Source | verified on Sourcify (`npm run evm:verify`), so Blockscout and Basescan show it |
| Airnode it trusts | CoinPaprika on AirnodeHub, `0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732` |
| Request it accepts | `0xd38b25988cb891a7b9cdc8d37a34b6c759156c8e1c42c7f205f91ae7cf057baf` = `getTickersById(bsv-bitcoin-sv, USD)` with the `price`/`updatedAt` projection |

`deployments/api3-price-guard.json` is the machine-readable record: network,
address, deploy transaction, block, settings and a public RPC.
`npm run api3:judge` does not trust it: it reads `airnode`, `requestHash`
and `maxDeviationBps` back from the chain and stops if anything differs.

### 0.2 Submit your own responses

The tamper test needs four real responses from CoinPaprika's Airnode: a fresh
BSV/USD one, an older BSV/USD one, and one to a different request (BTC/USD).
Each costs 0.001 aUSD; the
[AirnodeHub faucet](https://api3dao.github.io/airnodehub-hackathon/faucet/)
gives aUSD to any Base Sepolia address, and the payer needs no ETH.

```bash
npm install
API3_PAYER_KEY=0x… npm run api3:judge          # fetches BSV/USD and BTC/USD live, then runs the test
```

Every live response is saved in `deployments/api3-responses/`. The "too old"
case needs a BSV/USD response signed more than 5 minutes earlier: run the
command again after 5 minutes, or use one already saved there.

With responses you fetched yourself (POST the request that `npm run api3:price`
prints to `https://airnode-coinpaprika.fly.dev/`):

```bash
npm run api3:judge -- fresh.json --stale old.json --other btc.json
```

Without `--stale` and `--other`, the tool uses the newest suitable responses in
`deployments/api3-responses/`. The wrong-signer response is always made on the
spot: your fresh response's exact payload, re-signed by a random key.

**Who sends what:**
- Without a key, case 1 is a read-only check (`checkedPrice`, `fairSats`,
  `withinTolerance`), and cases 2–5 are `eth_call`s of `lockWithPrice`.
- With `API3_LOCKER_KEY` (a Base Sepolia key holding
  [test USDC](https://faucet.circle.com) and a little ETH), case 1 **locks
  1 USDC for real**, so the on-chain action is a transaction you can open on
  the explorer.
- Add `--send-rejections` to send cases 2–5 as transactions too. Their reverts
  are then on the explorer as well.

**Without cloning anything:** open the contract on the block explorer,
*Read contract* → `checkedPrice(timestamp, data, signature)`. Paste your
response's `timestamp`, `data` as hex bytes (`0x` + the UTF-8 bytes of the
string) and `signature`. A genuine, fresh response returns the price with 18
decimals; change one character of `data` and it reverts with
`NotSignedByAirnode`.

### 0.3 The tamper test: one valid, four rejected

Exactly the five submissions the API3 track asks for, all to
`lockWithPrice`, the contract's only way to lock funds:

| # | Submission | The contract answers |
|---|---|---|
| 1 | A valid, timely response, with an honest quote (fair rate − 0.5%) | ✅ **locks the USDC** (transaction, `PriceChecked` event) |
| 2 | A real response with one value edited (price halved, quote halved to match) | 🛑 `NotSignedByAirnode` |
| 3 | A real response that is too old (signed more than 5 minutes before the block) | 🛑 `ResponseTooOld` |
| 4 | A real response to a different request (CoinPaprika, BTC/USD) | 🛑 `NotSignedByAirnode` |
| 5 | A response signed by a key that is not the expected Airnode's | 🛑 `NotSignedByAirnode` |

Cases 2–5 are refused before any token moves. Case 4 gives
`NotSignedByAirnode` because the contract puts its **stored** request hash
into the signature check: a response to any other request recovers a different
signer. The tool prints `PASS` and exits with 0 only if all five answers match.

Offline, the same five cases run on a local chain whose guard trusts a test
key, with a real lock and the rejections sent as transactions:

```bash
npm run api3:judge -- --local --send-rejections
```

```
✅ 1. Valid, timely response                     locked               BSV = $17.4500; 1 USDC = 5730659 sats fair, quote 5702006; lock 0x91686165c2d546e5…
      tx 0xb9bad1b0caf0c046e0804189786db1e3b41442637ce38d5c17b093ac62eefd2b
🛑 2. Real response, one value edited            NotSignedByAirnode   "price" changed to 8.725 after signing
      tx 0x43986d7f7e25b57cdc137198a10d8ed6c186e673464098f7ec4422de0172a65c
🛑 3. Real response, too old                     ResponseTooOld       signed 60 min before this block
      tx 0x7f07c4e4661da75318391ee1094547e59ce2e6c79ba74d3e43d9739dae73232a
🛑 4. Real response, different request           NotSignedByAirnode   answers request 0xbc47b4b91e…, the contract only 0xd38b25988c…
      tx 0x4d0720d7693a2f383130ed1d57f198318a09458afd747a87ab4fb9c3bf4349fd
🛑 5. Signed by a key that is not the Airnode's  NotSignedByAirnode   signer 0xD3E609266121Cc80837358Ce38F0B69A79858FAA
      tx 0x21099d4079de88914b123d5c82deb4f19558801a270ba116da1d718d966d5ef4

PASS: 1 valid response locked, 4 tampered responses rejected before the lock.
```

Locally, "real" means signed by the test key the local contract trusts; on
Base Sepolia all four responses are CoinPaprika's own. Tests:
`test/api3.proof.evm.test.ts`.

### 0.4 For the Devfolio description

**Who relies on the data.** A donor who holds only USDC on an EVM chain and
wants to back a BSV campaign. They swap with a liquidity agent, an AI agent
that holds BSV. The donor relies on the BSV/USD price to get a fair number of
satoshis for their USDC; the liquidity agent relies on it to quote without
taking a loss. The contract uses it to decide whether the donor's USDC may be
locked at all.

**What goes wrong if it is forged.** A forged or stale price lets a dishonest
liquidity agent quote far fewer satoshis than the USDC is worth, and the swap
would still be "atomic": hash locks guarantee that both sides pay, not that the
rate is fair. With a signed, checked price, an edited, old, foreign or
wrongly signed response cannot lock the donor's funds (the tamper test above),
and an unfair quote is refused with `RateOutsideTolerance`.

**What we wanted but could not find on AirnodeHub.** A first-party BSV/USD
feed. API3's free first-party Nodary feeds have no BSV/USD (`/BSV~1USD/value`
does not exist), so we use CoinPaprika's third-party attestation, which is
paid per call. With a first-party BSV/USD feed, the price would come directly
from the data provider.

### 0.5 Deploying and verifying (team)

`data/api3-team.key` is a Base Sepolia **testnet** key (git-ignored). Fund
its address with Base Sepolia ETH, aUSD from the
[AirnodeHub faucet](https://api3dao.github.io/airnodehub-hackathon/faucet/)
and test USDC from the [Circle faucet](https://faucet.circle.com), then:

```bash
BRIDGE_PRICE_GUARD=api3 BRIDGE_RPC_URL=https://sepolia.base.org BRIDGE_DEPLOYER_KEY=$(cat data/api3-team.key) npm run evm:deploy   # writes deployments/api3-price-guard.json
npm run evm:verify                                                                    # publishes the exact source on Sourcify (no API key)
API3_PAYER_KEY=$(cat data/api3-team.key) API3_LOCKER_KEY=$(cat data/api3-team.key) npm run api3:judge -- --send-rejections
```

Run the last command twice, 5 minutes apart: the second run has a genuinely
old response for case 3. Commit `deployments/` and fill in the table in 0.1.
`evm/artifacts.json` is compiled from exactly the Standard JSON input that
`evm:verify` sends (`evm/compile.cjs`, `standardInput()`), so Sourcify gets a
byte-for-byte match.

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
- **No duplicate execution:** a swap's hashlock can lock only once
  (`HashlockAlreadyUsed`), so the same quote and signed response cannot lock
  a swap twice. A fresh price may still serve several different swaps, which
  is intended.

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
- ✅ The API3 tamper test (one valid response locks, an edited, a too-old,
  an other-request and a wrong-signer response are rejected) passes on a
  local chain (`npm run api3:judge -- --local`, `test/api3.proof.evm.test.ts`).
- ✅ One swap's hashlock can lock only once (`HashlockAlreadyUsed`).
- 🟡 **Not run yet:**
  - a paid live fetch (needs a Base Sepolia key with aUSD);
  - a deployment on Base Sepolia, its Sourcify verification and the tamper
    test against it (section 0.4).

  The commands are above. The code paths are the same as in the tests: only
  the RPC URL and the Airnode address change.
- 🟡 The adapter signs with local keys (tests, demo). In a browser, the
  donor's own EVM wallet would sign, as for the rest of the bridge
  (`docs/BRIDGING_PLAN.md`).

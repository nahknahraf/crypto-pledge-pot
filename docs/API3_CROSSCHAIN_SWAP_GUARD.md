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
| A deployed contract verifies the expected signer, the intended request and timing | ✅ on Base Sepolia | Checks 1–5 in [§2](#2-how-the-contract-verifies-api3-data-on-chain); address and network in [0.1](#01-deployed-contract) |
| A value bound to the exact signed response drives an on-chain action | ✅ | The signed price → `fairSats` → the lock goes through or reverts; what was checked is stored in `priceChecks[id]` and emitted as `PriceChecked` ([§2](#2-how-the-contract-verifies-api3-data-on-chain)) |
| Protection against duplicate execution | ✅ | A swap's hashlock can lock only once (`HashlockAlreadyUsed`); test in `test/api3.proof.evm.test.ts` |
| **Deployed contract address and network** | ✅ | Base Sepolia, [`0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673`](https://sepolia.basescan.org/address/0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673); [0.1](#01-deployed-contract) and [`deployments/api3-price-guard.json`](../deployments/api3-price-guard.json) |
| **A way for judges to submit their own responses** | ✅ | `npm run api3:judge` with your own response files, or live; or the explorer's *Read contract* tab ([0.2](#02-submit-your-own-responses)) |
| **Tamper test in the video: one valid, four rejected** | ✅ tool, tests and a live run on Base Sepolia · 🟡 video pending | [0.3](#03-the-tamper-test-one-valid-four-rejected); clip in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md) |
| **Description: who relies on the data, what goes wrong if forged, data we could not find** | ✅ text ready | [0.4](#04-for-the-devfolio-description) |

### 0.1 Deployed contract

| | |
|---|---|
| Network | Base Sepolia (chain id 84532) |
| `PriceGuardedHTLC` | [`0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673`](https://sepolia.basescan.org/address/0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673) |
| Deploy transaction | [`0xae6376a0…5c4082f545da`](https://sepolia.basescan.org/tx/0xae6376a077b68dcd9f217361fd0de7895d128ea0e98b120fbf1a5c4082f545da) (block 52629532) |
| Source | verified on Sourcify, **exact match**: [repo.sourcify.dev/84532/0x4d83ed0b…](https://repo.sourcify.dev/84532/0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673); also on [Blockscout](https://base-sepolia.blockscout.com/address/0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673?tab=contract) |
| Token it locks | `TestUSDC` [`0x6f97f5190fc3ca133f76350ca7350c49bf7cc5cb`](https://sepolia.basescan.org/address/0x6f97f5190fc3ca133f76350ca7350c49bf7cc5cb) (6 decimals, anyone can `mint`), deployed with the guard so judges can lock without a USDC faucet |
| Airnode it trusts | CoinPaprika on AirnodeHub, `0xB8b7816a39A0bF55eF2ae9A282A1502ce35ff732` |
| Request it accepts | `0xd38b25988cb891a7b9cdc8d37a34b6c759156c8e1c42c7f205f91ae7cf057baf` = `getTickersById(bsv-bitcoin-sv, USD)` with the `price`/`updatedAt` projection |

[`deployments/api3-price-guard.json`](../deployments/api3-price-guard.json) is the machine-readable record: network,
address, deploy transaction, block, settings and a public RPC.
`npm run api3:judge` does not trust it: it reads `airnode`, `requestHash`
and `maxDeviationBps` back from the chain and stops if anything differs.

### 0.2 Submit your own responses

You need Node.js ≥ 22 and a Base Sepolia key with a little ETH (for the aUSD
mint and the lock) and aUSD (0.001 per AirnodeHub call; mint it on the
[aUSD faucet](https://api3dao.github.io/airnodehub-hackathon/faucet/)).

```bash
git clone https://github.com/nahknahraf/crypto-pledge-pot && cd crypto-pledge-pot && npm install
API3_PAYER_KEY=0x… API3_LOCKER_KEY=0x… npm run api3:judge -- --send-rejections
```

That fetches a fresh BSV/USD response and a BTC/USD response ("a different
request") from CoinPaprika's Airnode, locks 1 TestUSDC with the fresh one, and
sends the four tampered responses as transactions, so every result is on the
explorer. Run it twice, 5 minutes apart: each live response is saved in
`deployments/api3-responses/`, and the second run uses the first run's
BSV/USD response as the "too old" one. The repository already contains
responses from our own runs, so the "too old" case works on your first run
too.

**Your own files** (for example a response you edited, or one you signed with
your own key):

```bash
npm run api3:judge -- fresh.json --stale old.json --other btc.json --edited edited.json --wrong mine.json
```

Every flag is optional; without one, the tool uses a saved response or, for
`--edited` and `--wrong`, makes it (fresh response with the price halved;
fresh payload re-signed by a random key).

**Which route.** Fetch with `POST /` and the exact body that
`npm run api3:price` prints:

```json
{"operation":"getTickersById","parameters":{"coin_id":"bsv-bitcoin-sv","quotes":"USD"},"responseProjection":{"price":"/quotes/USD/price","updatedAt":"/last_updated"}}
```

to `https://airnode-coinpaprika.fly.dev/` (it answers `402` until paid with
x402). The AirnodeHub website and MCP server use the passthrough route, which
hashes the same request differently, so the contract treats those responses
as "a different request" and refuses them.

**Who sends what:**
- `API3_LOCKER_KEY` locks for real. It needs TestUSDC: anyone can call
  `mint(address,uint256)` on
  [`0x6f97…7cc5cb`](https://sepolia.basescan.org/address/0x6f97f5190fc3ca133f76350ca7350c49bf7cc5cb).
  Without the key, case 1 is a read-only check (`checkedPrice`, `fairSats`,
  `withinTolerance`), and cases 2–5 are `eth_call`s.
- `--send-rejections` sends cases 2–5 as transactions, so their reverts are on
  the explorer as well.

**Without cloning anything:** open the contract on
[Blockscout](https://base-sepolia.blockscout.com/address/0x4d83ed0bd9d4361ac1d46bd87f50a88dae996673?tab=read_write_contract)
or Basescan, *Read contract* → `checkedPrice(timestamp, data, signature)`.
Paste your response's `timestamp`, `data` as hex bytes (`0x` + the UTF-8 bytes
of the string) and `signature`. A genuine, fresh response returns the price
with 18 decimals; change one character of `data` and it reverts with
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

**Live on Base Sepolia** (31 October 2026, 13:02, CoinPaprika's own signed
responses, every case a transaction you can open):

| # | Submission | Result | Transaction |
|---|---|---|---|
| 1 | Valid, timely BSV/USD response ($17.0229) | ✅ locked 1 TestUSDC | [`0x234e89…3cbe4`](https://sepolia.basescan.org/tx/0x234e893fc85397ad830ff2da3c1a74f05665522cece78d5b123e0799a653cbe4) |
| 2 | Same response, `"price"` halved after signing | 🛑 `NotSignedByAirnode` | [`0x2054ca…4519f`](https://sepolia.basescan.org/tx/0x2054ca9b1e2471fee1a6a93c9f4c4ddbde5020135a05d625d7f028978494519f) |
| 3 | Real BSV/USD response signed 6 min earlier | 🛑 `ResponseTooOld` | [`0xffa89f…a5c49`](https://sepolia.basescan.org/tx/0xffa89fdbcebb0b7ef47991f4824a207bf30caa796887ce5a9f8dac6587ba5c49) |
| 4 | Real BTC/USD response from the same Airnode | 🛑 `NotSignedByAirnode` | [`0xab22f2…d7065`](https://sepolia.basescan.org/tx/0xab22f2e389c42e36ff639883a9dc60721c4a1508942ac1a673b386ae4cad7065) |
| 5 | The valid payload signed by another key | 🛑 `NotSignedByAirnode` | [`0x762955…c7854`](https://sepolia.basescan.org/tx/0x7629551d39c9a7229038c8b5a66bbe9843048385d752d5ead705d4a6aecc7854) |

```
PASS: 1 valid response locked, 4 tampered responses rejected before the lock.
```

The signed responses are in `deployments/api3-responses/`.

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

`data/api3-team.key` is a Base Sepolia **testnet** key (git-ignored, address
`0x6439E2623B641e3d1f890A66c6Fcf6832fBC2991`). It only needs Base Sepolia ETH
from a faucet: `npm run api3:setup` mints aUSD from API3's faucet contract and
TestUSDC for the lock.

```bash
npm run api3:setup                                   # balances; mints aUSD (and TestUSDC after deploying)
API3_TEST_TOKEN=1 BRIDGE_PRICE_GUARD=api3 BRIDGE_RPC_URL=https://sepolia.base.org BRIDGE_DEPLOYER_KEY=$(cat data/api3-team.key) npm run evm:deploy
npm run evm:verify                                   # the exact source on Sourcify (no API key)
npm run api3:judge -- --send-rejections              # uses the team key; run twice, 5 minutes apart
```

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
  local chain (`npm run api3:judge -- --local`, `test/api3.proof.evm.test.ts`)
  and **live on Base Sepolia** with CoinPaprika's own signed responses
  ([0.3](#03-the-tamper-test-one-valid-four-rejected)).
- ✅ Deployed on Base Sepolia and verified on Sourcify with an exact match
  ([0.1](#01-deployed-contract)). Paid live fetches over x402 work (0.001 aUSD
  each).
- ✅ One swap's hashlock can lock only once (`HashlockAlreadyUsed`).
- 🟡 The deployment locks the project's TestUSDC, so judges need no USDC
  faucet; the swap flow itself works with any 6-decimal stablecoin.
- 🟡 The contract accepts responses from the `POST /` route only (the hash
  it stores). The AirnodeHub website and MCP server use the passthrough
  route, whose hash differs, so their responses count as "a different
  request".
- 🟡 The adapter signs with local keys (tests, demo). In a browser, the
  donor's own EVM wallet would sign, as for the rest of the bridge
  (`docs/BRIDGING_PLAN.md`).

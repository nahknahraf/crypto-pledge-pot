# Keys: what you need, how to get each one, where it goes

## Where to put the values

All secrets go in **one file, outside the repository**:

```
~/.config/cryptopledgepot/secrets.env      (readable only by you: mode 600)
```

Every `npm run …` command loads it, and a variable already set in your shell takes precedence.

Because the file is outside the repo, it can't be committed by accident, served by `npm run share:internet`, or copied into a container image.

| Command | What it does |
|---|---|
| `npm run secrets:init` | Creates the file, or adds the slots it lacks. It lists which keys have a value, never the values |
| `npm run keys:new` | Generates fresh **testnet** keys into the empty slots and prints the addresses to fund. It never replaces a key you set and never prints a key |

To paste a value, open the file in an editor and put it after the `=`, with no quotes and no spaces, for example `ANTHROPIC_API_KEY=sk-ant-…`.

To use another file, set `CPP_SECRETS_FILE=/path/to/file`; `CPP_SECRETS_FILE=none` loads no file.

**Rules**
- **Testnet keys only** for everything `keys:new` makes. They sit in a plain file.
- **Never** paste a key that holds real money, your BSV Desktop recovery phrase, or an exchange password. The project never asks for any of these.
- **Never** paste a secret into a chat, an issue or a commit.

---

## What each run needs

| You want to… | You need | Section |
|---|---|---|
| Run the agents with Claude instead of the scripted brains; `npm run eval:agents` | `ANTHROPIC_API_KEY` | [1](#1-claude-anthropic_api_key) |
| Run the USDC bridge on Base Sepolia (`npm run evm:deploy`, `npm run demo:bridge`, `npm run lp`) | EVM keys, test ETH, test USDC | [2](#2-base-sepolia-the-usdc-bridge) |
| Run the BTC bridge on signet (`npm run lp` with `BRIDGE_CHAIN=btc-signet`) | `LP_BTC_KEY`, a price | [3](#3-bitcoin-on-chain-signet) |
| Run the Lightning bridge (`npm run lp` with `BRIDGE_CHAIN=ln`) | Your own LND node | [4](#4-lightning-your-own-lnd-node) |
| Let the liquidity agent sell sats (any real run) | BSV in its wallet | [5](#5-bsv-the-liquidity-agents-inventory) |

Nothing here is needed for `npm test` or the offline demos (`npm run demo:bridge`, `demo:bridge:btc`, `demo:bridge:ln`).

---

## 1. Claude: `ANTHROPIC_API_KEY`

1. **Create a key** in the Claude Console (console.anthropic.com), under **API keys**.
2. **Paste it:** `ANTHROPIC_API_KEY=sk-ant-…`
3. **Check it:** `npm run eval:agents` prints `[eval] run 1/3 with <brain names>…`; the names should be the Claude brains, not the mock ones. The agents' start-up lines say `brain claude:…`.

Set a spend limit in the Console. The agents only use the model for judgement; caps, prices and amounts are decided in code.

## 2. Base Sepolia (the USDC bridge)

**Keys**
1. **Generate them:** `npm run keys:new`. This fills:
   - `BRIDGE_DEPLOYER_KEY`, which deploys the HTLC contract;
   - `BRIDGE_DONOR_KEY`, the demo donor;
   - `BRIDGE_LP_KEY`, the liquidity agent, also used as `LP_EVM_KEY`.

   It prints their addresses.

   To use keys you already have instead, paste `0x…` 64-hex private keys into those slots before running it. Use testnet-only wallets.

**Fund the addresses**
2. **Test ETH, for gas,** on all three addresses. Use a Base Sepolia faucet, for example the Coinbase Developer Platform faucet. A few thousandths of an ETH each is plenty.
3. **Test USDC** on the donor's address, from Circle's faucet (faucet.circle.com; choose Base Sepolia).

**Configure**
4. **Set the RPC and token:**
   - `BRIDGE_RPC_URL=https://sepolia.base.org` (the public endpoint, chain 84532);
   - `BRIDGE_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle's test USDC on Base Sepolia; checked on chain: symbol USDC, 6 decimals).
5. **Deploy the HTLC:** `npm run evm:deploy`, then paste the printed address as `BRIDGE_HTLC=0x…`.

**Run it**
6. **The whole swap, as both sides:** `npm run demo:bridge` (with `BRIDGE_USDC=1` for 1 USDC).
7. **The agent as a service:** `npm run lp`. Set `LP_SATS_PER_USDC` (your price) and keep `LP_MAX_USDC` small.

## 3. Bitcoin on chain (signet)

**Keys and price**
1. **`LP_BTC_KEY`:** made by `npm run keys:new`. It prints a `tb1…` address. That address is where the BTC the agent claims ends up; it needs no funding.
2. **`LP_SATS_PER_BTC`:** your price, in BSV sats per 1 BTC. `LP_MAX_BTC` is the largest swap (default 0.001).

**Bitcoin data source (choose one)**
3. **Default, nothing to set:** the public Esplora API, `https://mempool.space/signet/api`.
4. **Your own node, run with `-txindex`:** set `BTC_RPC_URL`, `BTC_RPC_USER` and `BTC_RPC_PASSWORD`.

**Run it**
5. **Start the agent:** `BRIDGE_CHAIN=btc-signet npm run lp`.

**Donors** pay from their own Bitcoin wallet, so they need signet coins from a signet faucet. The agent needs none.

## 4. Lightning (your own LND node)

The agent issues hold invoices from **its own** LND node; donors pay from any Lightning wallet. On a real network the node needs **inbound liquidity** of at least the swap size.

1. **The node's REST address:** `LND_REST_URL=https://<host>:8080` (LND's default REST port).
2. **The macaroon:** `LND_MACAROON_PATH=…/.lnd/data/chain/bitcoin/<network>/admin.macaroon`. The agent needs to:
   - create, settle and cancel invoices;
   - read node info, invoices and payments.

   On testnets, use the admin macaroon. Elsewhere, bake one with only those permissions.
3. **The TLS certificate:** `LND_TLS_CERT_PATH=…/.lnd/tls.cert`
4. **The price:** `LP_SATS_PER_BTC` (and `LP_MAX_BTC`).
5. **Start the agent:** `BRIDGE_CHAIN=ln npm run lp`. The web page `#/bring-btc` needs `VITE_LP_LN_URL` at build time.

## 5. BSV: the liquidity agent's inventory

The agent sells sats it holds.

**Its key**
- Its BSV key is generated on first start into `data/lp.key`, which is gitignored. You can also set `LP_ROOT_KEY`, or give each agent its own directory with `LP_DATA_DIR`.
- `npm run lp` prints its BSV identity key, and `GET /api/lp` publishes it.

**Top it up from your own wallet**
- Run `npm run lp:fund -- <sats> [lp url]`. BSV Desktop asks you to approve.
- The agent checks the payment by SPV before accepting it.
- Use `NETWORK=test` for testnet.

**Start small:** the agent only ever risks what you put in its wallet.

## Optional

| Key | What it is | Default |
|---|---|---|
| `AGENT_ROOT_KEY`, `LP_ROOT_KEY` | BSV root keys for the fundraising agent and the liquidity agent | Generated into `data/*.key` |
| `BITCOIND_BIN`, `LND_BIN` | Binaries for the regtest tests and demos | `~/opt/bitcoin-*/bin/bitcoind`, `~/opt/lnd-linux-amd64-*/lnd` |

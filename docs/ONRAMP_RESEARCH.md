# Fiat on-ramps and wrapped stablecoins: provider check (Phases 4–5)

**Checked on:** 2026-10-31, as `BRIDGING_PLAN.md` §1 requires ("Record the check, with the date").

**Label legend:**
- **verified**: read on the provider's own docs.
- **secondary**: comparison or press sites.
- **unverified**: the provider's page could not be read (HTTP 403 to automated access) or nothing confirmed it.

Re-check everything before it goes into the UI: exchange support for BSV changes over time.

## Summary

| Route | Status | What the user needs |
|---|---|---|
| **Fiat → USDC on Base → our swap → BSV** | **The recommended route**: well-supported on-ramps, then the tested **Bring USDC** swap | An on-ramp account and API key for the app (a decision for you, see below) |
| Fiat → BSV directly (card purchase) | Possible, but only through smaller providers; **unverified** | Nothing to build: the donor buys BSV and uses **Fund from an exchange** (a deposit address of their own wallet) |
| Exchange withdrawal of BSV | Works where the exchange still allows BSV withdrawals; major US exchanges reportedly don't list BSV | Nothing to build: **Fund from an exchange** already handles it |
| Wrapped stablecoins on BSV (BSV-21 USDC etc.) | **Research only**: no production bridge with audited contracts was found | — |

## 1. On-ramps to USDC on Base (feeds the Bring USDC swap)

**Coinbase Onramp** ([docs](https://docs.cdp.coinbase.com/onramp/docs/welcome), **verified**)
- **Delivery:** the docs say it "sends to any wallet address" and can add funds to "self-custody wallets directly from your app", including USDC on Base.
- **Integration:** "Coinbase-hosted" or "Headless", with session tokens. Setup starts by creating a **Secret API Key**: the app needs a Coinbase Developer Platform project.
- **Countries:** to be read from their Config and Options APIs per user. No fixed list is published on that page.
- **Fees** (**secondary**): USDC on Base is described as free on Coinbase's product page ([product page](https://www.coinbase.com/en-de/developer-platform/products/onramp), not readable here). Comparison sites give about 3.99% by card and about 1% by bank for other routes ([eco.com comparison](https://eco.com/support/en/articles/15210390-best-stablecoin-onramps-2026-moonpay-transak-coinbase-onramp-compared)).

**MoonPay, Transak** (**secondary**)
- **Coverage:** 160+ countries; both deliver USDC to self-custody addresses on several L2s.
- **Fees:**
  - card: about 3.5–5.5%;
  - bank: about 1% (SEPA/ACH).
- **Sources:** [eco.com](https://eco.com/support/en/articles/15210390-best-stablecoin-onramps-2026-moonpay-transak-coinbase-onramp-compared), [spark.money](https://www.spark.money/tools/which-crypto-on-ramp-should-i-use).
- **Not checked:** the figures disagree between sites, and live Base support was not checked on the providers' own pages.

## 2. Buying BSV directly

**Changelly** (**unverified**)
- **What it claims:** search snippets of its own pages ([changelly.com/buy/bsv](https://changelly.com/buy/bsv)) describe:
  - card purchases of BSV from about $5, sent to the buyer's wallet;
  - KYC above about $150 in some regions.
- **Why unverified:** the page returned HTTP 403 here.

**Exchanges** (**secondary**)
- **Major US exchanges:** Binance, Coinbase and Kraken are reported as no longer listing BSV ([Bitget news, 2026](https://www.bitget.com/news/detail/12560605322547)).
- **Smaller exchanges:** an undated tracker lists BSV withdrawals as online at HitBTC, MEXC and Poloniex, and suspended at Bitmart ([CoinLore](https://www.coinlore.com/coin/bitcoin-cash-sv/exchanges)).
- **HTX:** reported as sanctioned by the UK (May 2026) and the EU (July 2026) ([Wikipedia](https://en.wikipedia.org/wiki/HTX_(cryptocurrency_exchange))). **Don't recommend it.**
- **Already supported:** a withdrawal from any of these works today through **Fund from an exchange**, a deposit address of the user's own BRC-100 wallet. No exchange credentials are involved.

## 3. Wrapped stablecoins on BSV (Phase 5)

No production bridge with audited contracts was found, so this stays **research only**, as planned. Doing it would need:
- a BSV-21 variant of the escrow;
- campaigns denominated in a stablecoin.

## Decisions needed from you

1. **Which on-ramp to integrate**, if any. **Recommendation:** Coinbase Onramp for USDC on Base, because its own docs confirm delivery to any self-custody address.
   - It needs a Coinbase Developer Platform account and a Secret API key. Put the key in the secrets file and keep it server-side: the docs use session tokens, so the browser never sees the key.
   - The build is small: a "Buy USDC" button that opens the hosted on-ramp with the donor's own EVM address, then the existing Bring USDC swap.
2. **Which countries** you are targeting. This decides which provider covers your users.
3. **Whether to show direct BSV purchase links** (Changelly or an exchange) at all, given that they are unverified here.

Nothing in this file has been built into the UI. Per the plan, no provider goes into the UI until you choose it and its facts are checked on its own pages.

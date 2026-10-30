# TODO: edge cases and work still open

This is one list. The details live in [`VERIFICATION_PLAN.md`](VERIFICATION_PLAN.md) (§ numbers), [`AGENT_TEST_PLAN.md`](AGENT_TEST_PLAN.md) (F/D/S ids) and [`BRIDGING_PLAN.md`](BRIDGING_PLAN.md). Tick an item when its test or proof is committed.

## Before submission

- [ ] Mainnet run R1: launch, pledge, release, agent payments, report anchor. Txids go into `USAGE_AND_VALUE.md`. Needs about 10k team sats and `ANTHROPIC_API_KEY`.
- [ ] Record the video ([`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md)).
- [ ] Point ngrok at port 8081, not 80.
- [ ] Decide whether to keep the rate limits (asked, not answered).

## Edge cases: server and contracts

- [ ] Vote tie at exactly 50 % must fail (§4).
- [ ] The same pledge submitted twice is idempotent (§4).
- [ ] A pledge whose BEEF fails SPV is refused, tested with a strict chain tracker (§4).
- [ ] A pledge after the deadline; a vote from a refunded donor counts 0; a vote changed twice (§4).
- [ ] Server restart between handing out release signatures and the broadcast (§4).
- [ ] `MIN_PLEDGE` 100 vs 99; rounding that makes two stages equal; 1 and 10 milestones; the largest amount (§1).
- [ ] Two pledges released in one transaction; `unlockLength` equals the real size (§1).
- [ ] `validateCampaign` table: bad percentages and dates, `javascript:` agentUrl, a 10 kB description (§3).
- [ ] Swap secrets of 0, 31 and 33 bytes (§2).
- [ ] WhatsOnChain 429/500/timeout in the watcher; reorgs (§5).

## Edge cases: client, web app and ops

- [ ] The wallet user cancels; too few sats; a lost server reply after the broadcast (§6).
- [ ] Component tests: no `WalletClient` in mock mode; `confirmSpend`; a testnet wallet against a mainnet server; no wallet installed; SSE reconnect (§7). Needs a test setup (jsdom + Testing Library).
- [ ] Container restart keeps the DB and keys; `/@fs` and `data/` are unreachable via the share URL (§8).
- [ ] A smoke test for `npm run demo` (§9).

## Edge cases: agents

- [ ] Fundraising agent F1–F14. First F1 (paid but no data), F5 (no double pay on retry), F14 (no report before its anchor). F12 (single instance) needs a lock file.
- [ ] Donor agent D1–D13. First D3, D4, D5 (the chain beats a lying server; needs code), D10 (scan every text field; needs code).
- [ ] Liquidity agent S1–S11. S4 (LP restart) needs **persisted swap state**: today it lives in memory only. S10 needs confirmations on the source chain.
- [ ] A live-model eval: 20 scenarios × 3 runs, saved to `AGENT_EVAL_RESULTS.md`.

## Bridging (real money in)

Done: `SourceChain.now()` is async; there is an EVM HTLC + viem adapter with the happy path on Anvil (`demo:bridge`, `bridge.evm` tests). The rest of the bridging TBD list is in [`BRIDGING_PLAN.md` § TBD](BRIDGING_PLAN.md#tbd-after-the-happy-path).

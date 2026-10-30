# TODO: edge cases and work still open

This is one list. The details live in [`VERIFICATION_PLAN.md`](VERIFICATION_PLAN.md) (§ numbers), [`AGENT_TEST_PLAN.md`](AGENT_TEST_PLAN.md) (F/D/S ids) and [`BRIDGING_PLAN.md`](BRIDGING_PLAN.md). Tick an item when its test or proof is committed.

## Before submission

- [ ] Mainnet run R1: launch, pledge, release, agent payments, report anchor. Txids go into `USAGE_AND_VALUE.md`. Needs about 10k team sats and `ANTHROPIC_API_KEY`.
- [ ] Record the video ([`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md)).
- [ ] Point ngrok at port 8081, not 80.
- [ ] Decide whether to keep the rate limits (asked, not answered).

## Edge cases: server and contracts

- [x] Vote tie at exactly 50 % fails (§4).
- [x] The same pledge submitted twice gets 409 and is counted once (§4).
- [ ] A pledge whose BEEF fails SPV is refused, tested with a strict chain tracker (§4).
- [x] A pledge after the deadline is refused; a refunded donor's vote counts 0; a changed vote replaces the earlier one (§4).
- [ ] Server restart between handing out release signatures and the broadcast (§4).
- [x] `MIN_PLEDGE` 100 vs 99; rounding; 1 and the maximum of 4 milestones; the largest amount. The last one was a real float bug, fixed (§1).
- [ ] Two pledges released in one transaction; `unlockLength` equals the real size (§1).
- [x] `validateCampaign` table: 21 cases (§3).
- [x] Swap secrets of 0, 31 and 33 bytes (§2).
- [ ] WhatsOnChain 429/500/timeout in the watcher; reorgs (§5).

## Edge cases: client, web app and ops

- [ ] The wallet user cancels; too few sats; a lost server reply after the broadcast (§6).
- [ ] Component tests: no `WalletClient` in mock mode; `confirmSpend`; a testnet wallet against a mainnet server; no wallet installed; SSE reconnect (§7). Needs a test setup (jsdom + Testing Library).
- [ ] Container restart keeps the DB and keys; `/@fs` and `data/` are unreachable via the share URL (§8).
- [ ] A smoke test for `npm run demo` (§9).

## Edge cases: agents

- [ ] Fundraising agent: F3, F4, F6–F14 are open. Done: F1, F2 and F5 (paid-but-not-served is recorded; the cap holds across runs; both were real gaps, fixed). F12 (single instance) needs a lock file.
- [ ] Donor agent: D1 and D9 done. In co-pilot without `donorIdentityKey`, `approve` cannot check who paid (bookkeeping only). Open: D1–D13 otherwise. First D3, D4, D5 (the chain beats a lying server; needs code). D10 is partly done: the agent-addressing rule now runs in code for every brain, over the title, the description and the milestone titles, plus reports.
- [ ] Liquidity agent: S3, S7, S10 and S11 are open. Done: S2, S4 (persisted state, restart test), S5 (a real hole, fixed), S6, S8, S9. S1 does not apply to the LP (see DEVLOG 8.5).
- [ ] A live-model eval: 20 scenarios × 3 runs, saved to `AGENT_EVAL_RESULTS.md`.

## Bridging (real money in)

Done: `SourceChain.now()` is async; there is an EVM HTLC + viem adapter with the happy path on Anvil (`demo:bridge`, `bridge.evm` tests). The rest of the bridging TBD list is in [`BRIDGING_PLAN.md` § TBD](BRIDGING_PLAN.md#tbd-after-the-happy-path).

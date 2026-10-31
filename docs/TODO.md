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
- [x] A pledge whose BEEF fails SPV is refused, tested with a strict chain tracker (§4): `server.votes` runs a second server whose chain tracker knows no roots, and the pledge is refused.
- [x] A pledge after the deadline is refused; a refunded donor's vote counts 0; a changed vote replaces the earlier one (§4).
- [x] Server restart between handing out release signatures and the broadcast (§4): the next release request gets fresh signatures, and a release broadcast but never reported is indexed by the watcher (`watcher` test).
- [x] A pledge that fails SPV is refused (§4).
- [x] `MIN_PLEDGE` 100 vs 99; rounding; 1 and the maximum of 4 milestones; the largest amount. The last one was a real float bug, fixed (§1).
- [x] Several pledges released in one transaction; `unlockLength` covers the real size (§1): the e2e release spends 3 escrows in one transaction, and each hint is at most 16 bytes above the real unlocking script.
- [x] `validateCampaign` table: 21 cases (§3).
- [x] Swap secrets of 0, 31 and 33 bytes (§2).
- [x] WhatsOnChain 429/500/timeout in the watcher: one failure no longer aborts the round; a 429 ends it (§5). Reorgs: accepted for now (a spend is recorded once it has a proof; BSV reorgs deeper than a block are rare).

## Edge cases: client, web app and ops

- [x] A lost server reply after the broadcast: `registerWalletPledges` and "Find my pledges" (§6). The user cancelling and too few sats fail in the wallet before anything is broadcast.
- [x] The wallet gate as plain functions, with tests: mock never constructs a wallet; network mismatch; no wallet; the prompt (§7). SSE: the page reloads the campaign whenever the live feed (re)connects, so events missed during a server restart still show. Empty pages remain an unchecked UI case.
- [x] A container recreated on the same volume keeps the arbiter key and the DB (checked with Podman: same key hash, no new key generated) (§8). `npm run share:internet` now refuses to go public if the web server serves any `data/*.key` (leak check, tested against a safe and a leaky server).
- [x] A smoke test for `npm run demo` (§9).

## Edge cases: agents

- [x] Fundraising agent F1–F14. Tested: F1–F6, F8, F12 and F14 (F1, F5 and F14 were real gaps, fixed). By design: F7 (report text is posted as written; the limits are in code), F9 and F13 (no release means it waits; a refused or failed step is caught by `npm run agent` and retried next interval), F10 and F11 (a failed campaign stops it; an unreachable server fails the step cleanly).
- [x] Donor agent D1–D13. Done: D1, D3, D4, D6, D8–D13 (D4, D11 and D12 were real gaps, fixed). **Accepted limits:** D2 (one creator under two identity keys looks like two creators); D5 (a creator's track record comes from the server's statuses, while terms, anchors and reports are checked on chain, and in this design the server is also the arbiter, a trust assumption that refunds never depend on).
- [x] Liquidity agent S1–S11: all done (S5 and the crash window were real holes, fixed); see DEVLOG 8.5–8.25.
- [x] A live-model eval through the **Anthropic API**, 3 runs, and through the Claude Code CLI for comparison; results in [`AGENT_EVAL_RESULTS.md`](AGENT_EVAL_RESULTS.md). Every invariant held. The runs found two bugs, now fixed: the goal units in the donor prompt, and a wrong milestone in the eval fixture. The fundraising agent's full demo also ran with Claude through the API.
- [x] **Decided (owner, 2026-10-31): keep the risk-flag penalty.** Each flag costs 10 points (capped at −30), and the threshold stays at 60. The donor agent stays cautious: with real Claude, honest but sparse campaigns (50–58) need more detail before it funds them.

## Bridging (real money in)

Done: `SourceChain.now()` is async; there is an EVM HTLC + viem adapter with the happy path on Anvil (`demo:bridge`, `bridge.evm` tests). The rest of the bridging TBD list is in [`BRIDGING_PLAN.md` § TBD](BRIDGING_PLAN.md#tbd-after-the-happy-path).

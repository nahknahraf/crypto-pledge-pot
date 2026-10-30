# Testing CryptoPledgePot with other people over the internet

Run CryptoPledgePot on one laptop (the **host**) and let **testers** anywhere
use it through a fixed public HTTPS address from ngrok's free plan.

```
tester's browser ──HTTPS──▶ ngrok (your-name.ngrok-free.app) ──▶ host laptop :5175 (built app only)
      │                                                             ├─ /api, /.well-known → server :8787 (indexer + arbiter + watcher)
      │                                                             └─ /agent → agent :8791 (status, ledger, top-up)
      └──▶ the tester's OWN BSV Desktop (their keys never leave their computer)
```

Only the built web app and the proxied API and agent are reachable. The dev
server, `data/`, the keys and the wallet databases are never exposed (checked;
see DEVLOG "Sharing a local run").

---

## Part 1: the host (one-time setup, ~10 minutes)

1. **ngrok account:** sign up for free at <https://dashboard.ngrok.com/signup>.
2. **Auth token:** dashboard → *Your Authtoken* → copy it, then run:
   ```bash
   ngrok config add-authtoken <your token>
   ```
   (ngrok is already installed in `~/.local/bin`.)
3. **Free static domain:** dashboard → *Domains* → claim your free domain,
   e.g. `calm-otter-123.ngrok-free.app`.
4. **Config:**
   ```bash
   cp .env.share.example .env.share     # git-ignored
   # set NGROK_DOMAIN=calm-otter-123.ngrok-free.app
   # SHARE_MODE=main (real mainnet) or demo (offline demo, wallets disabled)
   # WITH_AGENT=yes to also run the AI agent; optionally ANTHROPIC_API_KEY=…
   ```
5. **Optional: rehearse locally first** (everything except the tunnel):
   `SKIP_TUNNEL=yes npm run share:internet`.

## Part 2: the host, each test session

```bash
npm run share:internet
```
It starts the server, the data API, the agent and the web app, waits until
each is healthy, opens the tunnel, and prints the link. **Ctrl+C stops
everything.** Logs are in `data/logs/`.

- Keep the laptop **awake and online** for the whole session.
- **The agent** (if `WITH_AGENT=yes`): on its first start it launches its own
  campaign, using the fixed `https://<domain>/agent` address. It needs about
  3,000 sats for fees: open its campaign and click **Top up agent fees**.
  Because the domain is fixed, the campaign keeps working across restarts.
- **The host needs no sats for the server.** The arbiter only signs; it never
  pays.
- Share the link only with your testers. Rate limits are on (per visitor:
  30 submissions/min, 120 API requests/min, 20 open live feeds), but this is
  still your laptop.

## Part 3: testers

You need:
- **BSV Desktop** on **mainnet**: <https://desktop.bsvb.tech>, created and
  unlocked;
- a few thousand sats (fractions of a cent);
- Chrome, Brave, Edge or Firefox on a computer. Phones can browse, but
  wallet actions need BSV Desktop.

Steps:
1. Open the link. On ngrok's free plan you first see an ngrok notice
   ("You are about to visit…"). Click **Visit Site**.
2. Click **Connect wallet**.
   - Your browser may ask to let the site **access apps on your device / local
     network**: allow it. That's how the page reaches BSV Desktop on your own
     computer.
   - BSV Desktop then asks for permissions for this site.
3. Every payment shows a CryptoPledgePot confirmation first, then your wallet's
   approval.

## Part 4: the test checklist (two or more testers)

Use tiny amounts. Write every txid down; they all show up on WhatsOnChain.

| # | Who | Do | Expect |
|---|---|---|---|
| 1 | Tester A | **Start a campaign** (goal ~2,000 sats, deadline ~15 min ahead, 2 milestones) | Listed on the home page for everyone |
| 2 | Tester B | **Donate** 1,500 sats with a message | Tester C (any device, no wallet needed) sees it appear in the **live feed** within seconds |
| 3 | Tester C | Donate 1,000 sats | After the deadline the campaign shows **Funded** |
| 4 | Tester A | Dashboard → **Withdraw milestone 1** | Sats arrive in A's wallet; the feed shows the release |
| 5 | A, then B and C | A posts an update; B and C vote **Approve**; A withdraws milestone 2 | Vote bar moves live; campaign **Completed** |
| 6 | Any | Start a campaign with an unreachable goal and a ~10 min deadline; someone donates; after the deadline they **Reclaim** | Refund arrives (the arbiter co-signs because the campaign failed) |
| 7 | Any | Back the **AI agent** campaign; after its deadline wait | The agent withdraws, buys data (agent panel lists payments with links), posts a report; testers vote; it withdraws milestone 2 |
| 8 | Any | Try with BSV Desktop on **testnet** | Clear "wrong network" message, no wallet action |
| 9 | Phone | Open the link | Layout fits; browsing works |
| 10 | Host | Watch `data/logs/server.log` | No errors; the watcher stays quiet unless someone spends outside the app |

The session passes when every row works and all txids are visible on
WhatsOnChain. Put the links into `docs/USAGE_AND_VALUE.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ngrok has no auth token yet` | `ngrok config add-authtoken <token>` |
| `Port 8787 is already in use` | Another CryptoPledgePot process is running: stop it (or Ctrl+C the other session) |
| `the tunnel did not come up` | Check `data/logs/ngrok.log`: is `NGROK_DOMAIN` the domain claimed on *this* ngrok account? |
| Tester: "Could not reach a BRC-100 wallet" | BSV Desktop not running or locked, or the browser blocked local-network access: allow it in the site settings |
| Tester: "Your wallet is on testnet…" | Switch BSV Desktop to mainnet |
| Live feed doesn't update | Reload once after the ngrok notice; check the host is still online |
| Agent panel "not reachable" | `WITH_AGENT=yes`, and the agent's campaign was launched with this domain (it was, if it was launched by `npm run share:internet`) |
| "Offline demo… wallet actions are disabled" | The host runs `SHARE_MODE=demo`; that's intended |

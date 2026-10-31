# CryptoPledgePot: plan for moving from local to the internet

**Goal:** anyone with BSV Desktop (or BSV Browser) can open a public HTTPS URL
and run the whole flow end to end on mainnet: launch, donate, the live feed,
release, vote, refund, recover, and the AI agent buying data. A judge without
a wallet can explore a hosted offline demo.

*Status: plan only, nothing deployed yet. Written 30 Oct 2026, after the
fixes in `docs/DEVLOG.md` (98 tests passing).*

---

## 1. What has to run, and where

| Service | Today (local) | Internet | Needs |
|---|---|---|---|
| Web app (React, static) | `npm run app` (Vite dev, :5174) | `vite build app` → static files served by the reverse proxy | HTTPS; same origin as the API (it calls `window.location.origin/api`) |
| Indexer + arbiter | `npm run server` (:8787) | Long-running Node process | **Persistent disk** (SQLite index, arbiter wallet DB), **secret** arbiter key, outbound HTTPS to Arcade + WhatsOnChain, SSE (long-lived connections) |
| Chain watcher | inside the server | same | Outbound to WhatsOnChain (free tier ~3 req/s) |
| Paid data API | `npm run data-provider` (:8790) | Long-running Node process | Persistent wallet DB, secret key, **large request headers** (BRC-121 payments reached 35 KB) |
| AI agent | `npm run agent` (:8791) | Long-running loop + small status API | Persistent wallet DB, ledger, state, secret key, `ANTHROPIC_API_KEY`; a few thousand sats of fee float |
| Offline demo (optional) | `npm run demo` | Separate instance, `network: mock` | Nothing persistent; wallet actions are disabled by design |

**Why not serverless:** the server, watcher and agent are long-running and
keep SQLite plus wallet databases on disk, and the live feed holds open SSE
connections. All of that wants a small always-on machine with a disk.

## 2. Recommended setup: one small VPS, Docker Compose, Caddy

```
                    ┌──────────────────────── VPS (2 vCPU, 4 GB, 40 GB disk) ───────────────────────┐
Internet ──443──▶  Caddy (automatic HTTPS)                                                         │
                    │  pledgepot.<domain>        /          → static web app (dist/app)             │
                    │                            /api/*, /.well-known/* → server:8787 (SSE: no buffering)
                    │  agent.<domain>            → agent:8791                                       │
                    │  data.<domain>             → data:8790   (header limit ≥ 1 MB)                │
                    │  demo.<domain> (optional)  → demo:8787 + same static app                       │
                    │                                                                               │
                    │  server ── volume: data/server   (cryptopledgepot.db, arbiter-wallet.sqlite)  │
                    │  agent  ── volume: data/agent    (agent-wallet.sqlite, ledger, state)          │
                    │  data   ── volume: data/provider (provider-wallet.sqlite)                     │
                    │  secrets via env file (chmod 600, not in git, not in the image)               │
                    └───────────────────────────────────────────────────────────────────────────────┘
       Arcade (SPV headers) · WhatsOnChain (BEEF, spends) · Anthropic API  ◀── outbound only
```

- **Host:** any VPS with a fixed IP (Hetzner CX22, DigitalOcean, etc., about
  €5–10/month). Fly.io or Railway with volumes also work, but four services
  plus volumes are simpler on one box.
- **Caddy, not nginx:** automatic Let's Encrypt certificates, and Go's 1 MB
  default header limit already fits BRC-121 payments. nginx's 8 KB default
  would break the agent's purchases (DEVLOG step 3).
- **Same origin for app and API:** the app already uses
  `window.location.origin`, and BRC-103 auth needs `/.well-known/auth` on that
  origin. Caddy routes both to the server, so no app code changes.
- **Internal traffic stays internal:** the agent talks to the server at
  `http://server:8787` on the Docker network. Only its *public* status URL
  (`AGENT_PUBLIC_URL=https://agent.<domain>`) is written into the campaign.

## 3. Code changes before deploying (small, all testable locally)

| # | Change | Why |
|---|---|---|
| C1 | Read `corsOrigin` from env (`CRYPTOPLEDGEPOT_CORS_ORIGIN=https://pledgepot.<domain>`) in `server/main.ts` | The option exists but is hard-wired to `*` |
| C2 | `app.set('trust proxy', 1)` when behind Caddy | Correct client IPs for rate limiting and logs |
| C3 | Rate limits on the public POSTs that do SPV work (`/api/spends`, `/api/import`) and on `/api/campaigns/:id/events` connections per IP | These are unauthenticated and cost CPU plus Arcade/WhatsOnChain calls: a cheap DoS vector |
| C4 | A `Dockerfile` (Node 22; `npm ci`; `vite build app`; entry points via `vite-node`, which we need for the single-SDK alias), plus `docker-compose.yml` and a `Caddyfile` | Repeatable deploys |
| C5 | `.env.example` listing every variable (already documented in `server/main.ts`, `fundraising-agent/main.ts`, `data-provider/main.ts`) | No guessing on the server |
| C6 | Optional: serve the built app from the server for the demo instance | One container for the hosted demo |
| C7 | Security headers (CSP allowing `localhost:3321`/`2121` for the wallet, WhatsOnChain and Arcade), via Caddy | Hardening; must not block the BRC-100 wallet connection |

## 4. Rollout, step by step

**Phase A: prepare (local, ~2–3 h)**
1. Make changes C1–C5; add a test for CORS and rate limits; `npm test`.
2. `docker compose up` locally with *fresh* keys and a mainnet config; run the
   read-only smoke checks (§6). Fix anything that differs from `npm run …`.

**Phase B: provision (~1 h)**
3. Buy or choose a domain; point `pledgepot.`, `agent.` and `data.` (and
   optionally `demo.`) at the VPS IP.
4. VPS hardening: SSH keys only, firewall open on 22/80/443 only, automatic
   security updates.
5. Install Docker; copy the repo (git clone); create `.env` (mode 600) with
   `NETWORK=main`, the domain URLs and `ANTHROPIC_API_KEY`.
6. **Keys:** decide whether to move the existing `data/arbiter.key` to the
   VPS (keeps "Fund a well" and its legacy arbiter key working; the import
   tool showed its campaign names this arbiter) or start with a new arbiter
   (old campaigns then need the old arbiter to sign). **Recommended:** move
   the existing arbiter key; generate new agent and provider keys on the
   server. Back up every key offline before first use.

**Phase C: deploy (~1 h)**
7. `docker compose up -d`; check `https://pledgepot.<domain>/api/health` →
   `{"network":"main", …}` and that the certificates are valid.
8. Re-import the mainnet history:
   `npm run import -- c13091938fe1… 0e637517…` (Fund a well). The watcher
   then keeps it current.
9. Fund the agent's fee float (~3,000 sats) with **Top up agent fees**, and
   let it launch its campaign.

**Phase D: end-to-end test on the internet (~1–2 h, two or three people)**
See §5. Record every txid.

**Phase E: hand-off**
10. Put the WhatsOnChain links into `docs/USAGE_AND_VALUE.md`; record the
    video from `docs/DEMO_SCRIPT.md` against the public URL; add the URLs to
    the README.

## 5. End-to-end test plan on the internet

Use **two people on different networks**, each with BSV Desktop on mainnet and
a few thousand sats, plus a third device with no wallet. Use tiny amounts.

| # | Who | Action | Expected | Record |
|---|---|---|---|---|
| 1 | Creator | Launch a campaign (goal 2,000 sats, deadline +15 min, 2 milestones) | Confirmation dialog → wallet approval → campaign listed | anchor txid |
| 2 | Backer | Donate 1,500 sats with a message | Confirmation → escrow; the **third device's live feed** shows it within seconds | donation txid |
| 3 | Backer 2 | Donate 1,000 sats | Status "Funded" after the deadline | donation txid |
| 4 | Creator | Withdraw milestone 1 | Released sats in the creator's wallet; feed shows the release | release txid |
| 5 | Creator / backers | Post update → backers vote YES → withdraw milestone 2 | Vote bar updates live; campaign "Completed" | release txid |
| 6 | Second campaign | Goal unreachable; deadline +10 min → backer reclaims (campaign failed) | Arbiter co-signs; refund in the backer's wallet | refund txid |
| 7 | Backer | Reclaim using another tool (or only the Recover panel's outpoint path, after a short refund date) | **The watcher** marks it refunded within ~5 min without a report | refund txid |
| 8 | Agent | Back the agent's campaign → it withdraws, buys data, posts its report → vote → milestone 2 | Agent panel lists every payment with links | release + ≥2 API payment txids |
| 9 | Anyone | Wrong network (testnet wallet) | Clear refusal, no wallet action | – |
| 10 | No wallet | Open the hosted demo | Yellow banner, Connect disabled, Donate refused | – |
| 11 | Phone | Open the app on a phone | Layout fits; read-only browsing works | screenshot |
| 12 | Automated (read-only) | Playwright smoke against the public URL: pages load, no console errors, `/api/health`, security probes (401/400/413 JSON) | All pass. **The script must never click payment buttons and must check that no wallet is listening, or run on a machine without one** | report |

**Exit criteria:** every row passes; all txids are visible on WhatsOnChain;
the agent made at least two real API payments; no unexpected wallet prompts.

## 6. Operations

- **Backups:** nightly copy of the three volumes (SQLite and wallet DBs) to
  off-site storage. Keys are backed up once, offline. The index can also be
  rebuilt from chain (`npm run import`), but wallet DBs and keys cannot.
- **Monitoring:** an uptime check on `/api/health`; Docker log rotation; alert
  if the watcher logs `pending` spends for more than an hour.
- **Updates:** `git pull && docker compose up -d --build`, after `npm test`
  passes locally.
- **Costs:** VPS €5–10/month; BSV fees are fractions of a cent per
  transaction; Anthropic usage is a few short calls per milestone.

## 7. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| Arbiter key leak | Can't take funds alone (the creator must also sign), but could help a colluding creator. Keep it in the env file only (mode 600), never in git or the image; rotate for new campaigns if exposed |
| VPS disk loss | Backups; the index can be rebuilt from chain; donors can always self-refund after the refund date, so funds never depend on the server |
| WhatsOnChain rate limits | The watcher pauses between calls; raise the interval if many escrows are active; a paid WhatsOnChain key or Arcade for spends later |
| Someone uses the hosted demo with a real wallet | Already prevented: `network: mock` means the wallet is never contacted |
| Spam campaigns or imports | Rate limits (C3); imports only accept campaigns naming this server's arbiter |
| Third-party paid APIs reject big BRC-121 headers | Documented; our data API runs behind Caddy with a 1 MB limit |

**Estimated total:** about one working day for two people, most of it Phase D
testing.

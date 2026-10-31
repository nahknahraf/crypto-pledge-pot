# Demo runbook: what to run, with and without Docker

What works, and how each part was verified: [`WHAT_WORKS.md`](WHAT_WORKS.md). Keys: [`KEYS.md`](KEYS.md).

## 1. Offline demos (no money, no keys; `npm ci` once)

| Command | Shows | Time |
|---|---|---|
| `npm run demo` + `npm run app` | The web app on a simulated world (campaigns in every state), at http://localhost:5174 | starts in ~20 s |
| `npm run demo:agent` | "AirWatch live": the fundraising agent's whole story, beat by beat (`DEMO_PACE_S=0` for no pauses) | ~2 min |
| `npm run demo:donor` | The donor agent: co-pilot proposals, then autopilot pledges, votes and refunds | ~1 min |
| `npm run rehearse:agents` | **Zero-click:** only agents, real Claude if `ANTHROPIC_API_KEY` is set, real Open-Meteo data. Ends with `Human actions: 0` | ~1.5 min |
| `npm run demo:swap` | The atomic swap on a simulated USDC ledger | ~30 s |
| `npm run demo:bridge` | The swap with a real Solidity HTLC on a local EVM chain (Anvil) | ~1 min |
| `npm run demo:bridge:btc` | The swap against a real Bitcoin Core node (regtest) | ~30 s |
| `npm run demo:bridge:ln` | The swap over Lightning with two real LND nodes (regtest) | ~20 s |
| `npm run eval:agents` | The agents' judgement scored on fixed scenarios (Claude with a key; `:cli` uses Claude Code) | ~3 min |
| `npm test` | 292 tests (the Bitcoin and Lightning ones skip themselves without the binaries) | ~2.5 min |

## 2. Docker / Podman

One image runs every Node service. Caddy serves the web app over HTTPS and proxies the APIs. Keys and databases live in one volume per service; `.dockerignore` keeps `data/`, `.env*` and keys out of the images.

**Verified on 2026-10-31** with rootless Podman 4.9 driving this `docker-compose.yml`:
- both images built;
- the `demo` profile ran;
- these routes answered: `https://localhost:8443/` (the web app), `/api/health`, `/api/campaigns` (5 campaigns, every state), `/agent/api/agent`, the plain-HTTP tunnel port `127.0.0.1:8081`, and HTTP→HTTPS on 8080.

**Built, not run:** the production stack (server, data provider and agent on mainnet) and the `agent-demo` and `tunnel` profiles.

**Setup, once**

```bash
cp .env.docker.example .env.docker   # git-ignored; set DOMAIN/PUBLIC_URL, and keys if moving an existing setup
# Rootless Docker/Podman can't bind ports below 1024, so set in .env.docker:
#   HTTP_PORT=8080  HTTPS_PORT=8443  PUBLIC_URL=https://localhost:8443
```

**With Podman instead of Docker** (no root, and no docker group needed):

```bash
systemctl --user start podman.socket
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
# then use docker-compose exactly as below
```

**Demo steps**

| Step | Command | Then open |
|---|---|---|
| 1. Offline demo (no money) | `docker-compose --env-file .env.docker --profile demo up -d --build caddy demo` | https://localhost:8443 (accept the local certificate) |
| 2. The agent story, live | `docker-compose --env-file .env.docker --profile agent-demo up -d --build caddy agent-demo` | https://localhost:8443: the demo banner shows each beat |
| 3. Production stack (mainnet) | `docker-compose --env-file .env.docker up -d --build` | `PUBLIC_URL`; top up the agent's fees on its campaign page |
| 4. Share from a laptop | Add `NGROK_DOMAIN` and `NGROK_AUTHTOKEN` to `.env.docker`, then `docker-compose --env-file .env.docker --profile tunnel up -d` | `https://<NGROK_DOMAIN>` |
| Status, logs | `docker-compose --env-file .env.docker ps`; `docker-compose --env-file .env.docker logs -f server` | |
| Stop | `docker-compose --env-file .env.docker --profile demo down` (add `-v` only to **delete** the volumes and their keys) | |

**Notes**
- **Startup:** Caddy answers `502` for the first ~20 s, until the Node services are up (vite-node compiles on start).
- **Redirects with custom ports:** with `HTTPS_PORT=8443`, the HTTP→HTTPS redirect points to `https://localhost/` without the port, so open `https://localhost:8443` directly.
- **ngrok:** point an ngrok you run yourself at port **8081**, never 80 (80 redirects to HTTPS and loops through the tunnel).
- **Backups:** back up the volumes. `server-data` holds the arbiter key that every campaign's escrow names.

## 2b. Live demo for an audience: people create campaigns and donate (Docker, mainnet)

This is the real stack: anyone with the link creates a campaign or donates from **their own** BSV wallet. The platform never holds their keys.
- **Verified 2026-10-31** (Podman): the stack came up on mainnet. The server and the data provider were healthy, the agent started, and the app was live (no offline banner) with a working "Start a campaign" form.
- **Not done yet:** a donation through it. That needs a person with a wallet: try it yourself first at `https://localhost:8443`.

**Visitors need:** BSV Desktop (laptop) or BSV Browser (phone), holding a few hundred sats of their own.
- Creating a campaign costs a fraction of a cent.
- The minimum pledge is 100 sats.
- The app shows the USD value (about $17 per BSV on 2026-10-31).

**Set up, once, in `.env.docker`** (git-ignored):

```bash
NETWORK=main
HTTP_PORT=8080
HTTPS_PORT=8443                  # rootless Docker/Podman
NGROK_AUTHTOKEN=<from ngrok>     # the public link for visitors
NGROK_DOMAIN=<your-name>.ngrok-free.app
PUBLIC_URL=https://<your-name>.ngrok-free.app   # must match the link (CORS, the agent's public page)
ANTHROPIC_API_KEY=<key>          # the AI agent's Claude brain (otherwise a deterministic brain)
# Remove the old AGENT_GOAL / AGENT_MAX_SPEND lines (ignored now; the terms come from the spending plan)
```

**On the day:**

| Step | Command / action |
|---|---|
| 1. Start the stack and the public link | `docker-compose --env-file .env.docker --profile tunnel up -d --build` (with Podman, first: `systemctl --user start podman.socket; export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock`) |
| 2. Check | `docker-compose --env-file .env.docker ps`: all healthy; `https://<NGROK_DOMAIN>/api/health` says `"network":"main"` |
| 3. Give the AI agent its fee float | Open its campaign page once it appears, or find its status at `/agent/api/agent`. Click **Top up agent fees** (about 3,000 sats from your wallet). It then launches its own campaign (goal 1,200 sats) |
| 4. Visitors | Share the link or a QR code. They connect their wallet, then **Start a campaign** (title, story, goal, deadline, milestones) or **Donate** to any campaign |
| 5. Show the rest | Donors vote on milestones on the campaign page; the AI agent buys data per call and posts anchored reports; on a failed campaign, donors use **Reclaim**. Every action links to WhatsOnChain |
| Logs | `docker-compose --env-file .env.docker logs -f server agent` |
| Stop | `docker-compose --env-file .env.docker --profile tunnel down`. **Never** add `-v` unless you mean to delete the volumes: `server-data` holds the arbiter key that every campaign's escrow names. Back it up first |

**Good to know**
- **Short demos:** use a short deadline, such as 30 minutes, for campaigns you want to show finishing. The milestones release as soon as the goal is met and the deadline has passed.
- **Releasing milestones:** a creator releases them from their own Dashboard (milestone 1 once funded; later ones after a >50 % YES vote).
- **The donor agents and the zero-click run** (§3) run on the host with npm. Point them at the Docker server with `CRYPTOPLEDGEPOT_URL=https://<NGROK_DOMAIN>` if you want agents giving alongside the visitors.

## 3. Zero-click on mainnet (only agents, nobody approving)

```bash
npm run rehearse:agents                               # 1. check offline with the same agents and brains
CPP_DATA_DIR=data/mainnet-run2 npm run agents:mainnet  # 2. start everything in its own folder
#   → it prints one deposit address and the amount (about 9,000 sats): pay it once from any wallet
npm run preflight                                      # 3. optional read-only check before recording
```

- **Funding:** the team treasury claims your deposit by SPV and funds every agent. From then on, the fundraising agent launches its campaign, the autopilot donor agents decide and pledge, and the reports, votes, releases and refunds all happen by themselves.
- **Stop:** Ctrl+C stops everything. The agents' wallets stay in `CPP_DATA_DIR` (git-ignored; back it up).
- **Docker:** zero-click runs on the host with npm for now; there is no Compose profile for it yet.

## 4. The mainnet recording

Follow `VIDEO_SCRIPT.md`: the zero-click version (recommended), or the one with human backers. Run `npm run preflight` first.

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

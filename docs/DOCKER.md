# Running CryptoPledgePot with Docker Compose

One build (`Dockerfile`), separate containers, one command.

| Container | Image target | Role | Volume |
|---|---|---|---|
| `caddy` | `web` | HTTPS, the built web app, reverse proxy (`/api`, `/.well-known/auth`, `/agent`) | certificates |
| `server` | `app` | indexer, arbiter, chain watcher | `server-data` (index, arbiter wallet, arbiter key) |
| `data-provider` | `app` | paid data API (internal only) | `provider-data` |
| `agent` | `app` | the AI agent + its status page | `agent-data` |
| `ngrok` *(profile `tunnel`)* | ngrok's image | public URL for a laptop | none |
| `demo` *(profile `demo`)* | `app` | offline demo instead of the three above | none |

Only Caddy is reachable from outside (ports 80/443, or through ngrok).
Containers talk to each other by name on the Compose network. Each Node
service keeps its own keys and databases in its own volume.

## Setup

```bash
cp .env.docker.example .env.docker      # git-ignored; fill it in (see below)
docker compose --env-file .env.docker up -d --build
docker compose --env-file .env.docker ps          # all "healthy"?
docker compose --env-file .env.docker logs -f agent
```

**A. Server with a domain (VPS):** point `DOMAIN` at the server's IP; set
`DOMAIN=pledgepot.example.com` and `PUBLIC_URL=https://pledgepot.example.com`.
Caddy obtains the certificate automatically (ports 80 and 443 must be open).

**B. Laptop through ngrok (no domain, no open ports):**
```bash
# .env.docker: DOMAIN=localhost, PUBLIC_URL=https://your-name.ngrok-free.app,
#              NGROK_DOMAIN=your-name.ngrok-free.app, NGROK_AUTHTOKEN=…
docker compose --env-file .env.docker --profile tunnel up -d --build
```

**C. Offline demo (wallets disabled):**
```bash
docker compose --env-file .env.docker --profile demo up -d --build caddy demo
```
Don't run the demo and the main services at the same time: the demo takes
over their names (`server`, `agent`).

## Keys and moving an existing setup

Empty key variables mean each service generates its key once, inside its
volume. To keep using the arbiter key that existing campaigns (e.g. "Fund a
well") were made with, set `CRYPTOPLEDGEPOT_ARBITER_KEY` to the contents of
`data/arbiter.key`, or copy that file into the `server-data` volume. Then
re-import those campaigns:
```bash
docker compose --env-file .env.docker exec server npm run import -- <anchor txid> <pledge txid>
```

## Backups and updates

- **Back up the volumes** `server-data`, `agent-data` and `provider-data`: keys
  and wallet databases can't be rebuilt. The index can be rebuilt from chain.
  ```bash
  docker run --rm -v cryptopledgepot_server-data:/v -v "$PWD":/b alpine tar czf /b/server-data.tgz -C /v .
  ```
  (Compose prefixes volume names with the project name: check `docker volume ls`.)
- **Update:** `git pull && docker compose --env-file .env.docker up -d --build`.

## Verified (30 Oct 2026, Podman 4.9.3 rootless with the Docker CLI)

Docker was installed but its socket still pointed at Podman, so the setup was
built and run through Podman's Docker-compatible API:
- **Images:** app 486 MB, web 67.6 MB. `npm ci` installed `better-sqlite3`
  without the compiler fallback. `caddy validate` (inside the web image):
  valid.
- **Demo profile:** healthy; through Caddy (https://localhost:8443) `/api/health`
  reports `mock`, all 5 campaigns load, `/agent/api/agent` answers, and the
  SSE live feed streams.
- **Main stack:** server and data-provider *healthy*; each service writes
  its own volume as user `node` (`arbiter.key` and `agent.key` mode 600); the
  agent stops cleanly at "insufficient funds" (a fresh, unfunded wallet).
- **Through Caddy:** unauthenticated write → 401; oversized body → JSON 413;
  spoofed `X-Forwarded-For` ignored; per-visitor limit enforced (30 accepted,
  then 429).

**Fixed during the first run** (DEVLOG): vite-node needs a writable
`node_modules/.vite-temp`; Podman needs fully qualified image names; ports are
configurable (rootless can't bind below 1024); and **an empty
`CRYPTOPLEDGEPOT_ARBITER_KEY` became a zero private key**. Keys are now
validated.

**Not verified yet:** the `tunnel` profile (needs your ngrok token), a real
domain with Let's Encrypt, and a run on Docker Engine itself (only through
Podman so far).

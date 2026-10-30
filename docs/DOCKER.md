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

## Not yet verified

Written and checked statically (YAML parsed; every command maps to an npm
script; every Caddy route reaches a service), but **never built or run**:
Docker isn't installed on the development machine. On first run, check:
1. `docker compose build`. Does `npm ci` install `better-sqlite3`?
   (Compilers are in the build stage as a fallback.)
2. All services reach `healthy`; `curl -k https://localhost/api/health` returns
   `{"network":"main",…}`.
3. The agent can write in its volume (key, wallet DB, ledger) as user `node`.
4. Through Caddy: the live feed streams (`curl -N …/events`), and
   `/agent/api/agent` answers.
5. Rate limits apply per visitor (Caddy keeps `X-Forwarded-For` from private
   networks only).

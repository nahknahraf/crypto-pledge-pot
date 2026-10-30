# Run CryptoPledgePot with Docker

Everything (web app, API, chain watcher, AI agent, paid data API) runs from
**one command**. Only Docker (or Podman) is needed.

## Start

```bash
cp .env.docker.example .env.docker
#   local test:  DOMAIN=localhost  PUBLIC_URL=https://localhost:8443  HTTP_PORT=8080  HTTPS_PORT=8443
#   a server:    DOMAIN=pledgepot.example.com  PUBLIC_URL=https://pledgepot.example.com  (ports 80/443)

docker compose --env-file .env.docker up -d --build
```

Open **https://localhost:8443** (local: accept the locally issued certificate)
or your domain. Check: `curl -k https://localhost:8443/api/health` →
`{"ok":true,"network":"main",…}`.

| Command | What |
|---|---|
| `docker compose --env-file .env.docker ps` | Status (server and data-provider show *healthy*) |
| `docker compose --env-file .env.docker logs -f agent` | Follow a service's log |
| `docker compose --env-file .env.docker down` | Stop (data is kept in volumes) |
| `docker compose --env-file .env.docker --profile demo up -d caddy demo` | **Offline demo** instead (simulated; wallets disabled). Stop the main stack first |
| `docker compose --env-file .env.docker --profile tunnel up -d` | Add **ngrok** in front (set `NGROK_DOMAIN`, `NGROK_AUTHTOKEN`, `PUBLIC_URL`) |
| `docker compose --env-file .env.docker exec server npm run import -- <txid>` | Re-import a campaign or pledge from chain |

## Good to know

- **Keys** are generated on first start inside each service's volume
  (`server-data`, `agent-data`, `provider-data`). **Back up those volumes.**
  To keep an existing arbiter, set `CRYPTOPLEDGEPOT_ARBITER_KEY` in `.env.docker`.
- **The agent** needs about 3,000 sats of fee money: open its campaign and click
  *Top up agent fees*.
- **Podman instead of Docker:** `systemctl --user start podman.socket`,
  `export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock`, then build
  the images directly (`podman build --target app -t cryptopledgepot-app .`
  and `--target web -t cryptopledgepot-web .`) and use `up -d --no-build`.
  (Compose's parallel build collides under Podman.)

Details: [`docs/DOCKER.md`](docs/DOCKER.md) · plan: [`docs/DOCKERISATION_PLAN.md`](docs/DOCKERISATION_PLAN.md)

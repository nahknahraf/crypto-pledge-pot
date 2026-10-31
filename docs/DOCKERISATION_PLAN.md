# Plan: dockerise the entire CryptoPledgePot application

*30 October 2026. Builds on the first Compose setup (commit `fe5d9d7`,
`docs/DOCKER.md`), which is written and statically checked but has **never
been built**: Docker isn't installed on the development machine yet.*

**Goal:** every part of the repository runs from containers with one command
per task, with no Node, npm or sCrypt installed on the host:
- the production stack;
- the offline demo;
- the tests;
- the contract toolchain;
- the recovery tools;
- a development setup.

The same images work on a laptop (with ngrok) and on a server (with a domain).

---

## 1. Inventory: what has to be containerised

| Part | Today | Container plan | Status |
|---|---|---|---|
| Web app (React) | `npm run app` / `share` | Built into the Caddy image (`web` target) | in `fe5d9d7` |
| Indexer + arbiter + watcher | `npm run server` | `server` service, own volume | in `fe5d9d7` |
| Paid data API | `npm run data-provider` | `data-provider` service, internal only | in `fe5d9d7` |
| AI agent | `npm run agent` | `agent` service, own volume | in `fe5d9d7` |
| Offline demo | `npm run demo` | `demo` profile | in `fe5d9d7` |
| Public URL for a laptop | ngrok | `tunnel` profile | in `fe5d9d7` |
| Re-import from chain | `npm run import` | `docker compose run --rm server npm run import -- …` | documented |
| **Test suite** (101 tests) | `npm test` | `tools` service / CI | **new** |
| **Type-check** | `npx tsc --noEmit` | `tools` service / CI | **new** |
| **sCrypt toolchain** (139 MB, downloads compiler 1.20.0) | `contracts/` | separate `contracts` image, run on demand | **new** |
| **Starter-kit overlay** (:8080) and its web UI | `npm run overlay` / `web` | optional `kit` profile | **new (decision needed)** |
| **Development setup** (hot reload) | Vite dev server | `compose.dev.yml`, bound to 127.0.0.1 only | **new** |
| **Data migration** (existing keys, wallet DBs, "Fund a well") | `data/` | one-off migration into volumes | **new** |
| **Backups / restore** | none | `backup` and `restore` scripts, tested | **new** |
| **CI** | none | build, test, smoke test the demo stack | **new** |

**Not containerised, by design:** BSV Desktop. It is each user's own wallet
on their own computer. No container ever holds a user's keys; the only keys
in volumes are the app's own (arbiter, agent, data provider).

## 2. Target layout

```
Dockerfile                    build → app (Node services) · web (Caddy + app) · tools (tests, tsc, CLIs)
contracts/Dockerfile          sCrypt toolchain image (pinned compiler), run on demand
docker-compose.yml            production stack + profiles: tunnel, demo, kit, tools
compose.dev.yml               development overrides (bind mounts, Vite dev server on 127.0.0.1)
deploy/Caddyfile              HTTPS, routes, headers
scripts/docker-migrate.sh     data/ → volumes (keys, wallet DBs, index)
scripts/docker-backup.sh      volumes → dated archive; scripts/docker-restore.sh
.github/workflows/docker.yml  CI: build, test in container, demo smoke test
docs/DOCKER.md                how to run everything (updated)
```

## 3. Phases

### Phase 0: prerequisites (host, ~15 min, needs you)
- Install Docker Engine + the Compose plugin (`sudo apt install docker.io
  docker-compose-v2`), and add your user to the `docker` group.
- Decide the open questions in §6.

### Phase 1: make the existing setup real (~1–2 h)
Work through the first-run checklist in `docs/DOCKER.md`:
1. `docker compose build`: does `npm ci` install `better-sqlite3`? (Compilers
   are in the build stage as a fallback.)
2. All services `healthy`; `curl -k https://localhost/api/health` returns
   `network: main`.
3. Services can write their volumes as user `node` (keys, wallet DBs, ledger,
   and vite-node's cache).
4. Through Caddy: the SSE live feed streams, `/agent/api/agent` answers, and
   `caddy validate` passes.
5. Rate limits apply per visitor behind Caddy (forwarded IP kept only from
   private ranges).

**Exit:** `docker compose up` gives a working stack on `https://localhost`,
and the demo profile shows all five demo campaigns.

### Phase 2: slimmer, safer runtime image (~2–3 h)
- **Stop running vite-node in production.** Bundle `server/main.ts`,
  `fundraising-agent/main.ts`, `data-provider/main.ts`, `server/demo.ts` and
  `server/importTx.ts` with `vite build --ssr`. Apply the same `@bsv/sdk` → CJS
  alias as `vitest.config.ts`, so the single-SDK rule still holds. The runtime
  image then needs only production dependencies (`npm ci --omit=dev`).
  Expected: well under half of today's 278 MB of node_modules.
- **Proof:** run the e2e tests against the *bundled* entry points as well, so a
  bundling mistake (e.g. a second SDK copy) fails CI instead of production.
- **Hardening:** read-only root filesystem with only `/app/data` writable;
  `no-new-privileges`; drop all Linux capabilities; memory and CPU limits per
  service; log rotation (`json-file`, max size and file count).
- **Keys as Docker secrets** (files under `/run/secrets`), not environment
  variables, which `docker inspect` would show. Small code change: read
  `*_KEY_FILE` before `*_KEY`.

### Phase 3: tools in containers (~1–2 h)
- **`tools` target and profile:** the full dev dependencies plus the test files.
  - `docker compose run --rm tools npm test` runs all 101 tests (mock chain,
    offline).
  - `docker compose run --rm tools npx tsc --noEmit` type-checks.
- **`contracts` image:** Node 22 with `scrypt-cli`/`scrypt-ts`, the compiler
  version pinned (1.20.0), downloaded **at image build time** with a checksum
  check. `docker compose run --rm contracts` runs compile → export → crosscheck
  and writes the artifact and fixtures back through a bind mount. Proof: the
  artifact is byte-identical to the committed one.
- **Recovery CLIs:** document `docker compose run --rm server npm run import -- …`.
  The Dashboard's Recover panel needs no container work.

### Phase 4: development setup (~1 h)
- `compose.dev.yml`: bind-mounts the source, runs the Vite dev server and the
  services with reload, and publishes **only on 127.0.0.1**. The dev server
  can serve repo files and must never be public (DEVLOG "Sharing a local run").
- `docker compose -f docker-compose.yml -f compose.dev.yml up`.

### Phase 5: migrate existing data (~30 min, needs you)
`scripts/docker-migrate.sh` copies, after a backup of `data/`:
- `data/arbiter.key` and the arbiter wallet DB → `server-data`. Required so
  "Fund a well" (legacy `bitfund` campaign) keeps its arbiter.
- `data/cryptopledgepot.db` → `server-data` (or re-import from chain).
- the agent and provider keys and wallet DBs → their volumes. Only if you want
  to keep those identities; they hold no funds today.

It checks afterwards that `/api/campaigns` lists "Fund a well" and that the
arbiter identity key is unchanged (`03142ca9…`).

### Phase 6: operations (~1 h)
- `docker-backup.sh` / `docker-restore.sh` for the three service volumes,
  plus **one test restore** into a fresh project to prove it works.
- An optional `restart`/`update` helper (`git pull && compose up -d --build`).

### Phase 7: CI (~1–2 h)
GitHub Actions on every push:
1. build all targets (with layer cache);
2. run `tools` (tsc and the 101 tests) inside the image;
3. **smoke-test the demo stack:** `compose --profile demo up`, wait for
   healthy, then check `/api/health` (`mock`), the five campaigns, the
   `/agent` status page, an SSE event, the JSON 413/401, and per-visitor 429;
4. optional: push images to GHCR.

The smoke test is read-only: **no browser automation clicks payment buttons,
and none runs where a wallet is listening** (the 30 Oct incident).

## 4. Running modes after dockerisation

| Mode | Command |
|---|---|
| Server with a domain | `docker compose --env-file .env.docker up -d` |
| Laptop through ngrok | `… --profile tunnel up -d` |
| Offline demo | `… --profile demo up -d caddy demo` |
| Tests / type-check | `docker compose run --rm tools npm test` |
| Recompile the contract | `docker compose run --rm contracts` |
| Development | `docker compose -f docker-compose.yml -f compose.dev.yml up` |
| Re-import from chain | `docker compose run --rm server npm run import -- <txid…>` |

## 5. Verification and exit criteria

The whole plan is done when:
- [ ] on a machine with **only Docker installed**, a fresh clone runs every
      mode above;
- [ ] `tools`: 101+ tests pass in the container; the contract artifact
      rebuilt in the `contracts` image is byte-identical;
- [ ] the bundled entry points pass the e2e tests (one SDK copy);
- [ ] the production stack is healthy; "Fund a well" is present after
      migration, with the same arbiter key;
- [ ] backup → restore into a fresh project works;
- [ ] CI is green, including the demo smoke test;
- [ ] the runtime image is measured and recorded (target: < 50% of today's
      node_modules);
- [ ] the end-to-end test with real testers (`docs/SHARING.md` §4) passes
      against the Docker stack.

## 6. Decisions needed from you

1. **Install Docker** on this machine (needs sudo); without it nothing can be
   built or verified.
2. **Migrate the existing keys and data,** or start the Docker stack with
   fresh keys? Migrating is recommended for the arbiter key, so "Fund a well"
   keeps working.
3. **The starter-kit overlay and web UI** (`overlay/`, `web/`): include them as
   a `kit` profile, or leave them out? They aren't part of CryptoPledgePot.
4. **Where to run:** laptop + ngrok (`tunnel` profile), a VPS with a domain,
   or both.
5. **Image registry:** push to GitHub Container Registry from CI, or build
   locally only?
6. **Rate limits:** they're already on (added with the sharing setup:
   per-visitor limits on submissions, requests and live feeds). Keep them,
   change the numbers, or turn them off (`limits: false`)?

## 7. Risks

| Risk | Mitigation |
|---|---|
| Bundling breaks the single-SDK rule (`script[serializedBytes]` errors) | Run the e2e tests against the bundled entry points (Phase 2) |
| `better-sqlite3` native build fails | Compilers in the build stage; same Debian base for build and runtime |
| sCrypt compiler download unavailable at build time | Pin the version and checksum; cache the image; the committed artifact means the app never needs the toolchain |
| Volume permissions (non-root `node`) | Directories created and owned in the image; verified in Phase 1 |
| Let's Encrypt rate limits while testing | Use Caddy's staging CA (`acme_ca`) until the domain setup is stable |
| Keys leaking via `docker inspect` or logs | Docker secrets (Phase 2); keys never logged; `.env.docker` git-ignored |
| Losing volumes | Backups plus a tested restore; the index can be rebuilt from chain, keys can't |

**Estimated effort:** about 1.5–2 working days. Phases 1–3 (~5–7 h) give a
fully containerised, tested stack; phases 4–7 add development, migration,
backups and CI.

# CryptoPledgePot: one build, two targets.
#   app → Node runtime for the server, the data provider and the agent (one image, three containers)
#   web → Caddy with the built web app (HTTPS, static files, reverse proxy)
# Used by docker-compose.yml.

# ── build: install dependencies and build the web app ────────────────────────
FROM docker.io/library/node:22-bookworm-slim AS build
# Compilers only in the build stage: a fallback if better-sqlite3 has no prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build app

# ── app: Node services ─────────────────────────────────────────────────────────
FROM docker.io/library/node:22-bookworm-slim AS app
ENV NODE_ENV=production
WORKDIR /app
# Keep dev dependencies: entry points run with vite-node, which loads ONE build of
# @bsv/sdk for our code and wallet-toolbox alike (see vitest.config.ts).
COPY --from=build /app /app
# data/ holds keys, wallet databases and the index: a volume per service, owned by
# the unprivileged node user (a new named volume inherits this ownership).
# vite-node writes a temporary bundle of its config to node_modules/.vite-temp (and a cache to .vite).
RUN mkdir -p /app/data /app/node_modules/.vite /app/node_modules/.vite-temp \
 && chown -R node:node /app/data /app/node_modules/.vite /app/node_modules/.vite-temp
USER node
EXPOSE 8787 8790 8791
CMD ["npm", "run", "server"]

# ── web: Caddy + static app ───────────────────────────────────────────────────
FROM docker.io/library/caddy:2 AS web
COPY --from=build /app/dist/app /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The CryptoPledgePot server (npm run server) listens on :8787. Proxying keeps the
// browser same-origin, including the BRC-103 handshake at /.well-known/auth.
const target = process.env.CRYPTOPLEDGEPOT_SERVER ?? 'http://localhost:8787'
const agent = process.env.AGENT_SERVER ?? 'http://localhost:8791'
const donor = process.env.DONOR_SERVER ?? 'http://127.0.0.1:8792'
const routineAgent = process.env.ROUTINE_AGENT_SERVER ?? 'http://127.0.0.1:8793'

// xfwd: pass the visitor's IP on (X-Forwarded-For), so the server's rate limits apply per visitor, not per tunnel.
const proxy = {
  '/api': { target, xfwd: true },
  '/.well-known': { target, xfwd: true },
  // The agent's status page, reachable through the same origin: /agent/api/agent → :8791/api/agent
  '/agent': { target: agent, xfwd: true, rewrite: (p: string) => p.replace(/^\/agent/, '') }
}

export default defineConfig({
  plugins: [react()],
  // Local development only. Never expose the dev server to the internet: it can
  // serve other files from the repository (e.g. data/*.db, wallet databases).
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: ['..'] },
    // The donor agent is personal (one donor, on their machine): only the LOCAL dev server reaches it.
    // Same for the routine agent: it pays from the user's budget, so it is never reachable through a tunnel.
    proxy: {
      ...proxy,
      '/donor': { target: donor, rewrite: (p: string) => p.replace(/^\/donor/, '') },
      '/routine-agent': { target: routineAgent, rewrite: (p: string) => p.replace(/^\/routine-agent/, '') }
    }
  },
  // `npm run share`: serves ONLY the built app (dist/app) plus the proxies.
  // This is the one to put behind a tunnel. SHARE_HOST = the tunnel's hostname.
  preview: {
    port: 5175,
    strictPort: true,
    allowedHosts: process.env.SHARE_HOST !== undefined ? [process.env.SHARE_HOST] : true,
    proxy
  },
  build: { outDir: '../dist/app', emptyOutDir: true }
})

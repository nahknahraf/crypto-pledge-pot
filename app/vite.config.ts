import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The CryptoPledgePot server (npm run server) listens on :8787. Proxying keeps the
// browser same-origin, including the BRC-103 handshake at /.well-known/auth.
const target = process.env.CRYPTOPLEDGEPOT_SERVER ?? 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: ['..'] },
    proxy: { '/api': target, '/.well-known': target }
  },
  build: { outDir: '../dist/app', emptyOutDir: true }
})

import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    // The page imports ../client and ../core from the repo root.
    fs: { allow: ['..'] }
  }
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // wallet-toolbox is CommonJS and loads the CJS build of @bsv/sdk. Point our
      // code at the same build so SDK objects (Transaction, Script…) are one
      // class instance across both. Browser and overlay runtimes are pure ESM
      // and do not need this.
      '@bsv/sdk': fileURLToPath(new URL('./node_modules/@bsv/sdk/dist/cjs/mod.js', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})

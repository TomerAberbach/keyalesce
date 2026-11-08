import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: `jsdom`,
    setupFiles: [`vitest.setup.ts`],
    coverage: {
      include: [`src`],
    },
    testTimeout: 60_000,
    execArgv: [`--expose-gc`],
  },
})

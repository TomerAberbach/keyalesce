import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: `jsdom`,
    setupFiles: [`vitest.setup.ts`],
    coverage: {
      include: [`src`],
    },
    testTimeout: 20_000,
    poolOptions: {
      forks: {
        execArgv: [`--expose-gc`],
      },
    },
  },
})

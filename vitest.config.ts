import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: [`vitest.setup.ts`],
    coverage: {
      include: [`src`],
    },
    testTimeout: 300_000,
    execArgv: [`--expose-gc`],
    unstubGlobals: true,
  },
})

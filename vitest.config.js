import config from 'tomer/vitest'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    testTimeout: 20_000,
  },
})

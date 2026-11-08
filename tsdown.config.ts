import terser from '@rollup/plugin-terser'
import { defineConfig } from 'tsdown/config'

export default defineConfig([
  {
    entry: `src/index.ts`,
    platform: `neutral`,
    sourcemap: `inline`,
    dts: false,
    publint: true,
    plugins: [
      terser({
        mangle: {
          properties: true,
        },
      }),
    ],
  },
  {
    entry: `src/index.ts`,
    dts: { dtsOnly: true },
  },
])

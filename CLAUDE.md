# keyalesce

Get the same key for the same sequence of values!

## Project structure

```
keyalesce
├── src/
│   ├── index.ts              # API entry point and trie pruning
│   ├── node.ts               # Trie node types and the root node
│   └── index.test.ts         # Tests
├── types/
│   └── jest-extended.d.ts    # Adds the jest-extended matchers to Vitest's types
├── vitest.setup.ts           # Registers the jest-extended matchers
│
└── .claude/
    └── hooks/lint-format.sh  # Lints and formats each written file
```

## Development

```sh
# Everything CI runs. Run before handing work back
pnpm check

pnpm format
pnpm lint
pnpm typecheck
pnpm knip      # Find unused files, dependencies, and exports
pnpm test
pnpm test -u   # Update snapshots
pnpm coverage
pnpm build     # Bundle with tsdown
```

## Testing

- Uses `vitest`, `@fast-check/vitest`, and `jest-extended`
- `*.test.ts` files are colocated with implementation
- Tests call `globalThis.gc`, so `vitest.config.ts` passes `--expose-gc` to the
  workers

## Build

- `tsdown.config.ts` mangles every property because the API exposes none. Tests
  read the source, so run `pnpm build` to check the bundle

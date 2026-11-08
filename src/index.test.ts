import { setTimeout } from 'node:timers/promises'
import { fc, test } from '@fast-check/vitest'
import {
  any,
  filter,
  flatMap,
  forEach,
  index,
  map,
  pipe,
  reduce,
  toArray,
  toSet,
  unique,
} from 'lfi'
import { afterEach, beforeEach, expect } from 'vitest'
import keyalesce from './index.ts'
import type { Key, TrieNode } from './node.ts'
import { rootNode } from './node.ts'

const gc = async (): Promise<void> => {
  // A single round of garbage-collection sometimes doesn't seem to be enough to
  // reclaim between tests or within tests. Run a couple of rounds to ensure
  // everything that can be reclaimed is reclaimed.
  await tick()
  globalThis.gc!()
  await tick()
  globalThis.gc!()
  await tick()
}

const tick = (): Promise<void> => setTimeout(0)

beforeEach(gc)
afterEach(gc)
fc.installGlobalPlugin(fc.beforeEach(gc))
fc.installGlobalPlugin(fc.afterEach(gc))

const anythingArb = fc.anything({ withBigInt: true })

test.prop([fc.array(anythingArb)])(
  `keyalesce returns a frozen key with no prototype`,
  values => {
    const key = keyalesce(values)

    expect(key).toBeFrozen()
    expect((key as Record<string, unknown>).prototype).toBeUndefined()
  },
)

test.prop([fc.array(anythingArb)])(
  `keyalesce returns the same key for the same sequence of values`,
  values => {
    const key1 = keyalesce(values)
    const key2 = keyalesce([...values])

    expect(key1).toBe(key2)
    expect(getKeys(rootNode)).toStrictEqual(new Set([key1]))
  },
)

test.prop([
  fc.uniqueArray(fc.array(anythingArb), {
    minLength: 2,
    comparator: (left, right) =>
      left.length === right.length &&
      left.every((value, index) => sameValueZero(value, right[index])),
  }),
])(
  `keyalesce returns different keys for differing sequences of values`,
  arrays => {
    const keys = arrays.map(keyalesce)

    for (let index = 1; index < keys.length; index++) {
      // Hurray for transitive property!
      expect(keys[index - 1]).not.toBe(keys[index])
    }
    expect(getKeys(rootNode)).toStrictEqual(new Set(keys))
  },
)

const sameValueZero = (left: unknown, right: unknown): boolean =>
  left === right || (Number.isNaN(left) && Number.isNaN(right))

test.prop([
  fc.array(
    fc.record({
      values: fc.array(anythingArb),
      shouldKeepKey: fc.boolean(),
    }),
  ),
])(`keyalesce prunes nodes of reclaimed keys`, async arrays => {
  let keys: Key[] | null = arrays.map(({ values }) => keyalesce(values))
  const keptKeys = pipe(
    arrays,
    index,
    filter(([, { shouldKeepKey }]) => shouldKeepKey),
    map(([index]) => keys![index]),
    reduce(toSet()),
  )
  keys = null

  await gc()

  expect(getKeys(rootNode)).toStrictEqual(keptKeys)
  expect(getInvalidNodes(rootNode)).toStrictEqual(new Set())

  // Ensure values can't be reclaimed by `gc` above.
  expect(arrays).toBe(arrays)
})

test.prop([
  fc.tuple(fc.array(anythingArb), fc.uniqueArray(fc.nat())).map(
    ([values, indices]) =>
      [
        values,
        pipe(
          indices,
          map(index => index % (values.length + 1)),
          unique,
          reduce(toArray()),
        ),
      ] as const,
  ),
])(
  `keyalesce prunes nodes of reclaimed keys with prefix values`,
  async ([values, indices]) => {
    for (const index of indices) {
      keyalesce(values.slice(0, index))
    }

    await gc()

    expect(getKeys(rootNode)).toBeEmpty()
    expect(getInvalidNodes(rootNode)).toBeEmpty()

    // Ensure values can't be reclaimed by `gc` above.
    expect(values).toBe(values)
  },
)

test.prop([
  fc.array(
    fc.array(
      fc.record({
        value: anythingArb,
        shouldKeepValue: fc.boolean(),
      }),
    ),
  ),
])(`keyalesce prunes nodes of keys with reclaimed values`, async arrays => {
  const keys: Key[] = arrays.map(values =>
    keyalesce(values.map(({ value }) => value)),
  )
  pipe(
    arrays,
    flatMap(values =>
      pipe(
        values,
        index,
        flatMap(([index, { value, shouldKeepValue }]) =>
          isObject(value) && !shouldKeepValue ? [[values, index] as const] : [],
        ),
      ),
    ),
    forEach(([values, index]) => (values[index]!.value = null)),
  )
  const keptKeys = pipe(
    arrays,
    index,
    filter(([, values]) =>
      values.every(({ value }) => !isObject(value) || Boolean(value)),
    ),
    map(([index]) => keys[index]),
    reduce(toSet()),
  )

  await gc()

  expect(getKeys(rootNode)).toStrictEqual(keptKeys)
  expect(getInvalidNodes(rootNode)).toStrictEqual(new Set())

  // Ensure keys can't be reclaimed by `gc` above.
  expect(keys).toBe(keys)
})

const isObject = (value: unknown): value is object => {
  const type = typeof value
  return type === `object` ? value !== null : type === `function`
}

const getKeys = (node: TrieNode): Set<Key> =>
  pipe(
    traverseNodes(node),
    flatMap(({ keyRef: ref }) => {
      const key = ref?.deref()
      return key ? [key] : []
    }),
    reduce(toSet()),
  )

const getInvalidNodes = (node: TrieNode): Set<TrieNode> =>
  pipe(
    traverseNodes(node),
    filter(node => {
      const { keyRef: ref, strongEdges, weakRefs } = node
      const isEmpty = !ref && !strongEdges && !weakRefs
      const hasEmptyValues =
        (ref && !ref.deref()) ??
        (strongEdges && !strongEdges.size) ??
        (weakRefs && (!weakRefs.size || any(ref => !ref.deref(), weakRefs)))
      return (node !== rootNode && isEmpty) || hasEmptyValues
    }),
    reduce(toSet()),
  )

const traverseNodes = (node: TrieNode): Iterable<TrieNode> => ({
  *[Symbol.iterator](): Iterator<TrieNode> {
    const stack = [node]
    do {
      const node = stack.pop()!
      yield node

      if (node.strongEdges) {
        stack.push(...node.strongEdges.values())
      }

      if (!node.weakRefs) {
        continue
      }

      for (const ref of node.weakRefs) {
        const key = ref.deref()

        if (!key) {
          continue
        }

        const nextNode = node.weakEdges!.get(key)

        // It feels like it shouldn't be possible for this to be undefined,
        // but maybe garbage collection can result in partial collection (e.g.
        // the WeakRef's value is reclaimed, but the value is not removed from
        // the WeakMap's keys).
        if (nextNode) {
          stack.push(nextNode)
        }
      }
    } while (stack.length > 0)
  },
})

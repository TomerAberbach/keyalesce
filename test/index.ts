/**
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { setTimeout } from 'timers/promises'
import { fc, jest, testProp } from 'tomer'
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
import { polykey } from '../src/index.js'
import type { Polykey, PolykeyNode } from '../src/node.js'
import { rootNode } from '../src/node.js'

jest.setTimeout(20_000)

const gc = async (): Promise<void> => {
  // A single round of garbage-collection sometimes doesn't seem to be enough to
  // reclaim between tests or within tests. Run a couple of rounds to ensure
  // everything that can be reclaimed is reclaimed.
  await tick()
  global.gc!()
  await tick()
  global.gc!()
  await tick()
}

const tick = (): Promise<void> => setTimeout(0)

beforeEach(gc)
afterEach(gc)
fc.configureGlobal({ asyncBeforeEach: gc, asyncAfterEach: gc })

const anythingArb = fc.anything({ withBigInt: true })

testProp(
  `polykey returns a frozen key with no prototype`,
  [fc.array(anythingArb)],
  values => {
    const key = polykey(values)

    expect(key).toBeFrozen()
    expect((key as Record<string, unknown>).prototype).toBeUndefined()
  },
)

testProp(
  `polykey returns the same key for the same sequence of values`,
  [fc.array(anythingArb)],
  values => {
    const key1 = polykey(values)
    const key2 = polykey([...values])

    expect(key1).toBe(key2)
    expect(getKeys(rootNode)).toStrictEqual(new Set([key1]))
  },
)

testProp(
  `polykey returns different keys for differing sequences of values`,
  [
    fc.uniqueArray(fc.array(anythingArb), {
      minLength: 2,
      comparator: (a, b) =>
        a.length === b.length &&
        a.every((value, index) => sameValueZero(value, b[index])),
    }),
  ],
  arrays => {
    const keys = arrays.map(polykey)

    for (let index = 1; index < keys.length; index++) {
      // Hurray for transitive property!
      expect(keys[index - 1]).not.toBe(keys[index])
    }
    expect(getKeys(rootNode)).toStrictEqual(new Set(keys))
  },
)

const sameValueZero = (a: unknown, b: unknown): boolean =>
  a === b || (Number.isNaN(a) && Number.isNaN(b))

testProp(
  `polykey prunes nodes of reclaimed keys`,
  [
    fc.array(
      fc.record({
        values: fc.array(anythingArb),
        shouldKeepKey: fc.boolean(),
      }),
    ),
  ],
  async arrays => {
    let keys: Polykey[] | null = arrays.map(({ values }) => polykey(values))
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
  },
)

testProp(
  `polykey prunes nodes of reclaimed keys with prefix values`,
  [
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
  ],
  async ([values, indices]) => {
    indices.forEach(index => polykey(values.slice(0, index)))

    await gc()

    expect(getKeys(rootNode)).toBeEmpty()
    expect(getInvalidNodes(rootNode)).toBeEmpty()

    // Ensure values can't be reclaimed by `gc` above.
    expect(values).toBe(values)
  },
)

testProp(
  `polykey prunes nodes of keys with reclaimed values`,
  [
    fc.array(
      fc.array(
        fc.record({
          value: anythingArb,
          shouldKeepValue: fc.boolean(),
        }),
      ),
    ),
  ],
  async arrays => {
    const keys: Polykey[] = arrays.map(values =>
      polykey(values.map(({ value }) => value)),
    )
    pipe(
      arrays,
      flatMap(values =>
        pipe(
          values,
          index,
          flatMap(([index, { value, shouldKeepValue }]) =>
            isObject(value) && !shouldKeepValue
              ? [[values, index] as const]
              : [],
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
  },
)

const isObject = (value: unknown): value is object => {
  const type = typeof value
  return type === `object` ? value !== null : type === `function`
}

const getKeys = (node: PolykeyNode): Set<Polykey> =>
  pipe(
    traversePolykeyNodes(node),
    flatMap(({ keyRef: ref }) => {
      const key = ref?.deref()
      return key ? [key] : []
    }),
    reduce(toSet()),
  )

const getInvalidNodes = (node: PolykeyNode): Set<PolykeyNode> =>
  pipe(
    traversePolykeyNodes(node),
    filter(node => {
      const { keyRef: ref, strongEdges, weakRefs } = node
      const isEmpty = !ref && !strongEdges && !weakRefs
      const hasEmptyValues =
        (ref && !ref.deref()) ||
        (strongEdges && !strongEdges.size) ||
        (weakRefs && (!weakRefs.size || any(ref => !ref.deref(), weakRefs)))
      return (node !== rootNode && isEmpty) || hasEmptyValues
    }),
    reduce(toSet()),
  )

const traversePolykeyNodes = (node: PolykeyNode): Iterable<PolykeyNode> => ({
  *[Symbol.iterator](): Iterator<PolykeyNode> {
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

import { setTimeout } from 'node:timers/promises'
import { fc, test } from '@fast-check/vitest'
import { any, filter, flatMap, map, pipe, reduce, toMap, toSet } from 'lfi'
import { afterEach, beforeEach, expect } from 'vitest'
import keyalesce from './index.ts'
import type { Key, TrieNode } from './node.ts'
import { resetRootNode, rootNode } from './node.ts'

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
fc.installGlobalPlugin(
  fc.beforeEach(async () => {
    await gc()
    resetRootNode()
  }),
)

const anythingArb = fc.anything({ withBigInt: true })

test.prop([fc.array(anythingArb)])(
  `keyalesce returns a frozen key with no prototype`,
  values => {
    const key = keyalesce(values)

    expect(key).toBeFrozen()
    expect((key as Record<string, unknown>).prototype).toBeUndefined()
  },
)

const isSameSequence = (left: unknown[], right: unknown[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => sameValueZero(value, right[index]))

const sameValueZero = (left: unknown, right: unknown): boolean =>
  left === right || (Number.isNaN(left) && Number.isNaN(right))

/**
 * Keys are stored by sequence ID, so errors contain IDs, which are indices into
 * the counterexample's sequences.
 */
type Model = {
  /** The index of the first sequence equal to each sequence. */
  sequenceIds: number[]

  /** The IDs of the objects in each sequence. */
  objectIds: number[][]

  objectCount: number
  held: Map<number, Key>
  dropped: Set<number>
}

type Real = (unknown[] | undefined)[]

type ModelCommand = fc.AsyncCommand<Model, Real>

const createModel = (sequences: unknown[][]): Model => {
  const ids = new Map<object, number>()
  const objectIds = sequences.map(sequence =>
    sequence.filter(isObject).map(value => {
      let id = ids.get(value)
      if (id === undefined) {
        ids.set(value, (id = ids.size))
      }
      return id
    }),
  )
  return {
    sequenceIds: sequences.map(sequence =>
      sequences.findIndex(other => isSameSequence(other, sequence)),
    ),
    objectIds,
    objectCount: ids.size,
    held: new Map(),
    dropped: new Set(),
  }
}

const isLive = (model: Readonly<Model>, index: number): boolean =>
  model.objectIds[index]!.every(id => !model.dropped.has(id))

const command = ({
  check = () => true,
  run,
  description,
}: {
  check?: (model: Readonly<Model>) => boolean
  run: (model: Model, real: Real) => void | Promise<void>
  description: string
}): ModelCommand => ({
  check,
  run: async (model, real) => run(model, real),
  toString: () => description,
})

// Commands contain unbounded indices, which are taken modulo the number of
// sequences or objects, so commands stay valid while fast-check shrinks the
// sequences.

const sequenceIndex = (model: Readonly<Model>, rawIndex: number): number =>
  rawIndex % model.sequenceIds.length

const callCommand = (rawIndex: number): ModelCommand =>
  command({
    check: model => isLive(model, sequenceIndex(model, rawIndex)),
    run: (model, real) => {
      const index = sequenceIndex(model, rawIndex)
      const id = model.sequenceIds[index]!
      const key = keyalesce([...real[index]!])

      const heldKey = model.held.get(id)
      if (heldKey && key !== heldKey) {
        throw new Error(`Got a new key for held sequence #${id}`)
      }
      for (const [otherId, otherKey] of model.held) {
        if (otherId !== id && otherKey === key) {
          throw new Error(`Got sequence #${otherId}'s key for sequence #${id}`)
        }
      }

      model.held.set(id, key)
    },
    description: `call(${rawIndex})`,
  })

const releaseCommand = (rawIndex: number): ModelCommand => {
  const idIn = (model: Readonly<Model>) =>
    model.sequenceIds[sequenceIndex(model, rawIndex)]!
  return command({
    check: model => model.held.has(idIn(model)),
    run: model => {
      model.held.delete(idIn(model))
    },
    description: `release(${rawIndex})`,
  })
}

const dropValueCommand = (rawIndex: number): ModelCommand => {
  const idIn = (model: Readonly<Model>) => rawIndex % model.objectCount
  return command({
    check: model => model.objectCount > 0 && !model.dropped.has(idIn(model)),
    run: (model, real) => {
      const id = idIn(model)
      model.dropped.add(id)
      for (const [index, ids] of model.objectIds.entries()) {
        if (ids.includes(id)) {
          real[index] = undefined
        }
      }
    },
    description: `dropValue(${rawIndex})`,
  })
}

const gcCommand = command({ run: () => globalThis.gc!(), description: `gc` })

const tickCommand = command({ run: tick, description: `tick` })

test.prop([
  fc.record({
    sequences: fc
      .record({
        base: fc.array(anythingArb),
        variants: fc.array(fc.tuple(fc.nat(), fc.array(anythingArb)), {
          minLength: 1,
        }),
      })
      .map(({ base, variants }) =>
        variants.map(([prefixLength, suffix]) => [
          ...base.slice(0, prefixLength % (base.length + 1)),
          ...suffix,
        ]),
      ),
    commands: fc.commands(
      [
        fc.nat().map(callCommand),
        fc.nat().map(releaseCommand),
        fc.nat().map(dropValueCommand),
        fc.constant(gcCommand),
        fc.constant(tickCommand),
      ],
      { size: `+1` },
    ),
  }),
])(
  `keyalesce keeps held keys and prunes reclaimed keys and values across calls and garbage collection`,
  async ({ sequences, commands }) => {
    const model = createModel(sequences)
    const real: Real = structuredClone(sequences)

    await fc.asyncModelRun(() => ({ model, real }), commands)

    await expectTrieToContainLiveHeldKeys(model)
    model.held.clear()
    await gc()
    expect(getKeys(rootNode)).toBeEmpty()
    expect(getInvalidNodes(rootNode)).toBeEmpty()
  },
)

const expectTrieToContainLiveHeldKeys = async (model: Model) => {
  await gc()

  const idByKey = pipe(
    model.held,
    map(([id, key]) => [key, id] as const),
    reduce(toMap()),
  )
  expect(
    pipe(
      getKeys(rootNode),
      map(key => idByKey.get(key)),
      reduce(toSet()),
    ),
  ).toStrictEqual(
    pipe(
      model.held.keys(),
      filter(id => isLive(model, id)),
      reduce(toSet()),
    ),
  )
  expect(getInvalidNodes(rootNode)).toBeEmpty()
}

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

import { setTimeout } from 'node:timers/promises'
import { fc, test } from '@fast-check/vitest'
import { any, filter, flatMap, map, pipe, reduce, toSet } from 'lfi'
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

  /** The objects in the sequences, by object ID. */
  objects: WeakRef<object>[]

  held: Map<number, Key>

  /** Every key keyalesce returned, with its sequence ID. */
  returned: Returned[]

  dropped: Set<number>
}

type Returned = { id: number; ref: WeakRef<Key> }

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
    objects: ids
      .keys()
      .map(value => new WeakRef(value))
      .toArray(),
    held: new Map(),
    returned: [],
    dropped: new Set(),
  }
}

/** Whether the sequence can still be passed to keyalesce. */
const isLive = (model: Readonly<Model>, index: number): boolean =>
  model.objectIds[index]!.every(id => !model.dropped.has(id))

/** Whether every object in the sequence is still alive. */
const isReachable = (model: Readonly<Model>, index: number): boolean =>
  model.objectIds[index]!.every(id => model.objects[id]!.deref() !== undefined)

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

      if (!heldKey) {
        model.returned.push({ id, ref: new WeakRef(key) })
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
  const idIn = (model: Readonly<Model>) => rawIndex % model.objects.length
  return command({
    check: model => model.objects.length > 0 && !model.dropped.has(idIn(model)),
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
    const real = structuredClone(sequences)
    const model = createModel(real)

    await fc.asyncModelRun(() => ({ model, real }), commands)

    await reclaim(model)
    expectTrieToContainLiveKeys(model)

    model.held.clear()
    await reclaim(model)
    expectTrieToContainLiveKeys(model)
  },
)

const HAS_CONSERVATIVE_GC = `Bun` in globalThis

/**
 * Collects garbage until every released key and dropped value is reclaimed.
 *
 * V8, which Node and Deno use, scans the stack precisely, so a few collections
 * reclaim every unreachable object, and an object that survives them leaked.
 *
 * JavaScriptCore, which Bun uses, scans the stack conservatively. A stale copy
 * of an object's address in a stack slot or register keeps the object alive
 * until something overwrites it, which can take any number of collections. The
 * engine stays consistent while it does: the object's finalizer doesn't run, so
 * keyalesce keeps its trie entry. On Bun, this gives up after a few rounds
 * instead of failing, and `expectTrieToContainLiveKeys` checks the trie against
 * whatever is still alive. That can't tell a leak from a stale address, so the
 * property can't detect a leak on Bun.
 */
const reclaim = async (model: Readonly<Model>): Promise<void> => {
  const maxRounds = HAS_CONSERVATIVE_GC ? 5 : 100
  let rounds = 0
  let unreclaimed: boolean
  do {
    await gc()
    rounds++
    unreclaimed = hasUnreclaimed(model)
  } while (unreclaimed && rounds < maxRounds)
  if (unreclaimed && !HAS_CONSERVATIVE_GC) {
    throw new Error(`A released key or dropped value was never reclaimed`)
  }
}

const hasUnreclaimed = (model: Readonly<Model>): boolean => {
  const held = new Set<Key>(model.held.values())
  return (
    model.returned.some(({ ref }) => {
      const key = ref.deref()
      return key !== undefined && !held.has(key)
    }) || model.dropped.values().some(id => model.objects[id]!.deref())
  )
}

/**
 * Checks that the trie contains exactly the returned keys that are alive and
 * whose sequence is reachable.
 */
const expectTrieToContainLiveKeys = (model: Readonly<Model>): void => {
  const idByKey = new Map<Key, number>()
  for (const { id, ref } of model.returned) {
    const key = ref.deref()
    if (key !== undefined) {
      idByKey.set(key, id)
    }
  }

  expect(
    pipe(
      getKeys(rootNode),
      map(key => idByKey.get(key)),
      reduce(toSet()),
    ),
  ).toStrictEqual(
    pipe(
      idByKey.values(),
      filter(id => isReachable(model, id)),
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

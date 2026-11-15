import type { Key, Primitive, TrieNode } from './node.ts'
import { rootNode } from './node.ts'

/**
 * Returns a frozen key with no prototype for the sequence of values in
 * `iterable`.
 *
 * Returns the same key for equal sequences while the key is reachable. Two
 * sequences are equal if they have the same length and their values at each
 * index are equal by
 * [SameValueZero](https://tc39.es/ecma262/#sec-samevaluezero), so objects are
 * compared by identity, `NaN` equals `NaN`, and `0` equals `-0`.
 *
 * keyalesce holds keys and the objects in sequences weakly. Once a key is
 * reclaimed, the next call for its sequence returns a new key.
 *
 * @example
 * ```js
 * const hangouts = new Set()
 * hangouts.add(keyalesce([`Tomer`, `Samuel`]))
 *
 * console.log(hangouts.has(keyalesce([`Tomer`, `Samuel`])))
 * //=> true
 * console.log(hangouts.has(keyalesce([`Samuel`, `Tomer`])))
 * //=> false
 * ```
 *
 * @see https://tomeraberba.ch/the-making-of-keyalesce
 */
const keyalesce = (iterable: Iterable<unknown>): Key => {
  // Finish iterating before modifying the trie because iterating can throw.
  const values = [...iterable] as (object | Primitive)[]

  // Walk the values' path, creating missing nodes. Walking an existing path
  // allocates nothing.
  let node = rootNode
  for (const value of values) {
    const weak = isObject(value)
    const edges: Edges = weak
      ? (node.weakEdges ??= new WeakMap())
      : (node.strongEdges ??= new Map())
    let next = edges.get(value)
    if (!next) {
      const edge = weak ? new WeakRef(value) : value
      next = { parentEdge: [edge, node] }
      if (weak) {
        ;(node.weakRefs ??= new Set()).add(edge as WeakRef<object>)
      }
      edges.set(value, next)
    }
    node = next
  }

  const existingKey = node.keyRef?.deref()
  if (existingKey) {
    return existingKey
  }

  const key = Object.freeze(Object.create(null) as object)
  const keyRef = new WeakRef(key) as KeyRef
  keyRef.trieNode = node
  node.keyRef = keyRef

  // Register the key and the sequence's objects, so reclaiming any of them
  // prunes the key's path without traversing the whole trie.
  for (const value of [key, ...values]) {
    if (isObject(value)) {
      registry.register(value, keyRef, keyRef)
    }
  }
  return key
}
export default keyalesce

const isObject = (value: unknown): value is object => {
  const type = typeof value
  return type === `object` ? value !== null : type === `function`
}

const registry = new FinalizationRegistry<KeyRef>(keyRef => {
  // Unregister the key's other callbacks, because this callback prunes the
  // whole path.
  registry.unregister(keyRef)

  // Free the node's key only if it's the one this callback was registered for,
  // because keyalesce may have stored a new key for the same sequence before
  // this callback ran.
  const lastNode = keyRef.trieNode
  if (lastNode.keyRef === keyRef) {
    delete lastNode.keyRef
  }

  // Walk up from the key's node to the root. Remove reclaimed weak refs from
  // every node on the path, and remove edges to empty nodes until reaching a
  // nonempty node. Remove an edge only if it still leads to the node, because
  // the path may be stale. Another finalizer may have already removed the edge,
  // and keyalesce may have since added an edge for the same value to a new
  // node.
  let prune = true
  for (let node = lastNode; node.parentEdge;) {
    const isEmpty =
      !node.keyRef?.deref() && !node.strongEdges?.size && !node.weakRefs?.size
    prune &&= isEmpty
    const [edge, parent] = node.parentEdge
    const weak = isObject(edge)
    const value = weak ? edge.deref() : edge
    const edges: Edges | undefined = weak
      ? parent.weakEdges
      : parent.strongEdges
    // A reclaimed value's edge is detached, because the value derefs to
    // undefined and `WeakMap.get(undefined)` returns undefined.
    const isAttached = edges?.get(value) === node
    if (isAttached && prune) {
      edges.delete(value)
    }
    if (!isAttached || prune) {
      if (weak) {
        const { weakRefs } = parent
        const emptiedWeakRefs = weakRefs?.delete(edge) && !weakRefs.size
        if (emptiedWeakRefs) {
          delete parent.weakEdges
          delete parent.weakRefs
        }
      } else if (!parent.strongEdges?.size) {
        delete parent.strongEdges
      }
    }

    node = parent
  }
})

type KeyRef = WeakRef<Key> & { trieNode: TrieNode }

/** The operations shared by a node's weak and strong edge maps. */
type Edges = {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  get: (value: any) => TrieNode | undefined
  set: (value: any, node: TrieNode) => void
  delete: (value: any) => boolean
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

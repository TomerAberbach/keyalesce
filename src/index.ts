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
  const values = [...iterable] as Value[]
  return findKey(values) ?? createKey(createNodesAndRefs(values))
}
export default keyalesce

// Walks the trie without building the path that `createKey` needs, so looking
// up an existing key allocates nothing.
const findKey = (values: Value[]): Key | undefined => {
  let node: TrieNode | undefined = rootNode
  for (const value of values) {
    node = isObject(value)
      ? node.weakEdges?.get(value)
      : node.strongEdges?.get(value)
    if (!node) {
      return undefined
    }
  }
  return node.keyRef?.deref()
}

const createNodesAndRefs = (values: Value[]): NodesAndRefs => {
  // Find the node path corresponding to the values. Classify each value as
  // object or primitive and create new nodes for new paths through the trie.
  const nodes = [rootNode]
  const refs: Ref[] = []
  let node = rootNode
  for (const value of values) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let edges: MapLike<any, TrieNode>

    if (isObject(value)) {
      let weakRef = weakRefs.get(value)
      if (!weakRef) {
        weakRefs.set(value, (weakRef = new WeakRef(value)))
      }
      refs.push({ weak: weakRef })

      edges =
        node.weakEdges ??
        ((node.weakRefs = new Set()), (node.weakEdges = new WeakMap()))
      node.weakRefs!.add(weakRef)
    } else {
      refs.push({ strong: value })

      // eslint-disable-next-line no-multi-assign
      edges = node.strongEdges ??= new Map()
    }

    let next = edges.get(value)
    if (!next) {
      edges.set(value, (next = {}))
    }
    nodes.push((node = next))
  }

  return [nodes, refs]
}

type MapLike<K, V> = {
  get: (key: K) => V | undefined
  set: (key: K, value: V) => void
}

/**
 * We need to ensure that we use the same WeakRef for the same object if it is
 * used in multiple intersecting paths. Otherwise, the WeakRef sets used for
 * tracking WeakMap size could have multiple WeakRefs for the same object and
 * the size would not reflect the true size of the WeakMap.
 */
const weakRefs = new WeakMap<object, WeakRef<object>>()

const isObject = (value: unknown): value is object => {
  const type = typeof value
  return type === `object` ? value !== null : type === `function`
}

const createKey = ([nodes, refs]: NodesAndRefs): Key => {
  const key = Object.freeze(Object.create(null) as object)
  const keyRef = new WeakRef(key)
  nodes.at(-1)!.keyRef = keyRef

  // We can't only depend on the refs for pruning because they may be reclaimed
  // and then we won't have a way to find the nodes that might need to be pruned
  // without traversing the whole trie.
  const registration: Registration = [nodes, refs, keyRef]
  registry.register(key, registration, registration)
  for (const { weak } of refs) {
    if (weak) {
      registry.register(weak.deref()!, registration, registration)
    }
  }

  return key
}

const registry = new FinalizationRegistry<Registration>(registration => {
  // Unregister other callbacks for the same key. We'll clean up everything now.
  registry.unregister(registration)

  const [nodes, refs, keyRef] = registration

  // Free the key and remove reclaimed weak refs from affected nodes. Free the
  // key only if it's this registration's, because keyalesce may have stored a
  // new key for the same sequence before this callback ran.
  const lastIndex = nodes.length - 1
  const lastNode = nodes[lastIndex]!
  if (lastNode.keyRef === keyRef) {
    delete lastNode.keyRef
  }
  for (const [index, { weak }] of refs.entries()) {
    if (weak && !weak.deref()) {
      removeWeakRef(nodes[index]!, weak)
    }
  }

  for (
    let index = lastIndex;
    index >= 1 && isEmptyNode(nodes[index]!);
    index--
  ) {
    const node = nodes[index - 1]!
    const ref = refs[index - 1]!
    if (ref.weak) {
      removeWeakEdgeToEmptyNode(node, ref.weak, nodes[index]!)
    } else {
      removeStrongEdgeToEmptyNode(node, ref.strong, nodes[index]!)
    }
  }
})

// An object's reclaimed WeakRef stays in the set of every node with an edge
// for the object until a finalizer removes it. Every such edge is on the path
// of a registration for the object, so the finalizers that run when the object
// is reclaimed remove all of them.
const removeWeakRef = (node: TrieNode, weak: WeakRef<object>): void => {
  const { weakRefs } = node
  if (weakRefs?.delete(weak) && !weakRefs.size) {
    delete node.weakEdges
    delete node.weakRefs
  }
}

const isEmptyNode = ({ keyRef, strongEdges, weakRefs }: TrieNode): boolean =>
  !keyRef?.deref() && !strongEdges?.size && !weakRefs?.size

// The edge-removal functions remove an edge only if it still leads to the
// emptied node. A finalizer's path may be stale: another finalizer may have
// already removed the edge, and keyalesce may have since added an edge for the
// same value to a new node.
const removeWeakEdgeToEmptyNode = (
  node: TrieNode,
  weak: WeakRef<object>,
  emptyNode: TrieNode,
) => {
  const value = weak.deref()
  const { weakEdges } = node
  if (!value || weakEdges?.get(value) !== emptyNode) {
    return
  }

  weakEdges.delete(value)
  removeWeakRef(node, weak)
}

const removeStrongEdgeToEmptyNode = (
  node: TrieNode,
  strong: Primitive,
  emptyNode: TrieNode,
) => {
  const { strongEdges } = node
  if (strongEdges?.get(strong) !== emptyNode) {
    return
  }

  strongEdges.delete(strong)
  if (!strongEdges.size) {
    delete node.strongEdges
  }
}

type NodesAndRefs = [TrieNode[], Ref[]]

type Registration = [...NodesAndRefs, WeakRef<Key>]

type Ref =
  | { weak: WeakRef<object>; strong?: never }
  | { weak?: never; strong: Primitive }

type Value = object | Primitive

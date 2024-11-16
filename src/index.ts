import type { Key, Primitive, TrieNode } from './node.js'
import { rootNode } from './node.js'

const keyalesce = (iterable: Iterable<unknown>): Key =>
  findOrCreateKey(createNodesAndRefs(iterable))
export default keyalesce

const createNodesAndRefs = (iterable: Iterable<unknown>): NodesAndRefs => {
  // Find the node path corresponding to the values. Classify each value as
  // object or primitive and create new nodes for new paths through the trie.
  const nodes = [rootNode]
  const refs: Ref[] = []
  let node = rootNode
  for (const value of iterable as Iterable<object | Primitive>) {
    // eslint-disable-next-line typescript/no-explicit-any
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

const findOrCreateKey = (nodesAndRefs: NodesAndRefs): Key => {
  const [nodes, refs] = nodesAndRefs
  const lastNode = nodes.at(-1)!

  let key = lastNode.keyRef?.deref()
  if (key) {
    return key
  }

  key = Object.freeze(Object.create(null) as object)
  lastNode.keyRef = new WeakRef(key)

  // We can't only depend on the refs for pruning because they may be reclaimed
  // and then we won't have a way to find the nodes that might need to be pruned
  // without traversing the whole trie.
  registry.register(key, nodesAndRefs, nodesAndRefs)
  for (const { weak } of refs) {
    if (weak) {
      registry.register(weak.deref()!, nodesAndRefs, nodesAndRefs)
    }
  }

  return key
}

const registry = new FinalizationRegistry<NodesAndRefs>(nodesAndRefs => {
  // Unregister other callbacks for the same key. We'll clean up everything now.
  registry.unregister(nodesAndRefs)

  const [nodes, refs] = nodesAndRefs

  // Free the key and remove reclaimed weak refs from affected nodes.
  const lastIndex = nodes.length - 1
  delete nodes[lastIndex]!.keyRef
  nodes.forEach(removeReclaimedEdges)

  for (
    let index = lastIndex;
    index >= 1 && isEmptyNode(nodes[index]!);
    index--
  ) {
    const node = nodes[index - 1]!
    const ref = refs[index - 1]!
    if (ref.weak) {
      removeWeakEdgeToEmptyNode(node, ref.weak)
    } else {
      removeStrongEdgeToEmptyNode(node, ref.strong)
    }
  }
})

const removeReclaimedEdges = (node: TrieNode): void => {
  const { weakRefs } = node
  if (!weakRefs) {
    return
  }

  // Some objects may have been reclaimed. Remove WeakRefs to reclaimed objects
  // from the set for space efficiency and to have an accurate count of the
  // number of keys in the WeakMap.
  for (const ref of weakRefs) {
    if (!ref.deref()) {
      weakRefs.delete(ref)
    }
  }

  if (!weakRefs.size) {
    delete node.weakEdges
    delete node.weakRefs
  }
}

const isEmptyNode = ({ keyRef, strongEdges, weakRefs }: TrieNode): boolean =>
  !keyRef?.deref() && !strongEdges?.size && !weakRefs?.size

const removeWeakEdgeToEmptyNode = (node: TrieNode, weak: WeakRef<object>) => {
  // The value was already reclaimed.
  if (!weak.deref()) {
    return
  }

  // It's possible this node was already cleaned up if multiple keys, where one
  // is a prefix of another, were reclaimed at the same time.
  const { weakEdges, weakRefs } = node
  if (!weakEdges) {
    return
  }

  weakEdges.delete(weak.deref()!)
  weakRefs!.delete(weak)
  if (!weakRefs!.size) {
    delete node.weakEdges
    delete node.weakRefs
  }
}

const removeStrongEdgeToEmptyNode = (node: TrieNode, strong: Primitive) => {
  // It's possible this node was already cleaned up if multiple keys, where one
  // is a prefix of another, were reclaimed at the same time.
  const { strongEdges } = node
  if (!strongEdges) {
    return
  }

  strongEdges.delete(strong)
  if (!strongEdges.size) {
    delete node.strongEdges
  }
}

type NodesAndRefs = [TrieNode[], Ref[]]

type Ref =
  | { weak: WeakRef<object>; strong?: never }
  | { weak?: never; strong: Primitive }

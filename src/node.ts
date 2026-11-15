// `resetRootNode` reassigns this binding.
// eslint-disable-next-line import/no-mutable-exports
export let rootNode: TrieNode = {}

/**
 * Replaces the root node with an empty one. Finalizers registered before the
 * reset modify only the old trie.
 *
 * Internal only.
 */
export const resetRootNode = (): void => {
  rootNode = {}
}

/**
 * A single node in the trie.
 *
 * The trie tracks "paths", comprised of sequences of values, to keys. Common
 * path prefixes are shared between paths. It is a trie with strong (for
 * primitives) and weak (for objects) edges.
 *
 * The trie is pruned using FinalizationRegistry when either objects in the path
 * or keys have no strong references to them.
 */
export type TrieNode = {
  /**
   * The edge from the parent to this node, or none for the root. The tuple
   * contains the edge's value and the parent, with an object value stored as a
   * weak ref. Each edge creates its own weak ref, so a parent's set of weak
   * refs contains one per object.
   */
  parentEdge?: [WeakRef<object> | Primitive, TrieNode]

  keyRef?: WeakRef<Key>
  strongEdges?: Map<Primitive, TrieNode>
  weakEdges?: WeakMap<object, TrieNode>

  /**
   * A WeakMap doesn't expose its size, which we need for cleaning up empty
   * nodes. Keep track of the WeakMap size using a set of WeakRefs to the keys.
   * We can't use a Map with WeakRef keys because it wouldn't compare
   * keys based on the contained WeakRef values.
   */
  weakRefs?: Set<WeakRef<object>>
}

export type Key = object

export type Primitive =
  null | undefined | string | number | boolean | symbol | bigint

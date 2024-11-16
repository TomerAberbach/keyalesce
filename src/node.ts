export const rootNode: TrieNode = {}

/**
 * A single node in the trie.
 *
 * The trie tracks "paths", comprised of sequences of values, to keys. Common
 * path prefixes are shared between paths. It is essentially a trie with strong
 * (for primitives) and weak (for objects) edges.
 *
 * The trie is pruned using FinalizationRegistry when either objects in the path
 * or keys have no strong references to them.
 */
export type TrieNode = {
  keyRef?: WeakRef<Key>
  strongEdges?: Map<Primitive, TrieNode>
  weakEdges?: WeakMap<object, TrieNode>

  /**
   * A WeakMap doesn't expose its size, which we need for cleaning up empty
   * nodes. Keep track of the WeakMap size using a set of WeakRefs to the keys.
   * We can't simply use a Map with WeakRef keys because it wouldn't compare
   * keys based on the contained WeakRef values.
   */
  weakRefs?: Set<WeakRef<object>>
}

export type Key = object

export type Primitive =
  | null
  | undefined
  | string
  | number
  | boolean
  | symbol
  | bigint

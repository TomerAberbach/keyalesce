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

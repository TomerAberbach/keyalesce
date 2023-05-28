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

import type { Polykey, PolykeyNode, Primitive } from './node.js'
import { rootNode } from './node.js'

export const polykey = (iterable: Iterable<unknown>): Polykey =>
  findOrCreateKey(createNodesAndRefs(iterable))

const createNodesAndRefs = (iterable: Iterable<unknown>): NodesAndRefs => {
  // Find the polykey node path corresponding to the values. Classify each value
  // as object or primitive and create new nodes for new paths through the
  // polykey tree.
  const nodes = [rootNode]
  const refs: Ref[] = []
  let node = rootNode
  for (const value of iterable as Iterable<object | Primitive>) {
    // eslint-disable-next-line typescript/no-explicit-any
    let edges: MapLike<any, PolykeyNode>

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
const weakRefs: WeakMap<object, WeakRef<object>> = new WeakMap()

const isObject = (value: unknown): value is object => {
  const type = typeof value
  return type === `object` ? value !== null : type === `function`
}

const findOrCreateKey = (nodesAndRefs: NodesAndRefs): Polykey => {
  const [nodes, refs] = nodesAndRefs
  const lastNode = nodes[nodes.length - 1]!

  let key = lastNode.keyRef?.deref()
  if (key) {
    return key
  }

  key = Object.freeze({})
  lastNode.keyRef = new WeakRef(key)

  // We can't only depend on the refs for pruning because they may be reclaimed
  // and then we won't have a way to find the nodes that might need to be pruned
  // without traversing the whole tree.
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

const removeReclaimedEdges = (node: PolykeyNode): void => {
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

const isEmptyNode = ({ keyRef, strongEdges, weakRefs }: PolykeyNode): boolean =>
  !keyRef?.deref() && !strongEdges?.size && !weakRefs?.size

const removeWeakEdgeToEmptyNode = (
  node: PolykeyNode,
  weak: WeakRef<object>,
) => {
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

const removeStrongEdgeToEmptyNode = (node: PolykeyNode, strong: Primitive) => {
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

type NodesAndRefs = [PolykeyNode[], Ref[]]

type Ref =
  | { weak: WeakRef<object>; strong?: never }
  | { weak?: never; strong: Primitive }

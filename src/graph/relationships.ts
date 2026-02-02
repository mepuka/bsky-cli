import { Graph, Option } from "effect";
import type { RelationshipView } from "../domain/bsky.js";

export type RelationshipNode = {
  readonly did?: string;
  readonly handle?: string;
  readonly displayName?: string;
  readonly inputs: ReadonlyArray<string>;
  readonly notFound?: boolean;
};

export type RelationshipEdge = {
  readonly following: boolean;
  readonly followedBy: boolean;
  readonly mutual: boolean;
  readonly blocking: boolean;
  readonly blockedBy: boolean;
  readonly blockingByList: boolean;
  readonly blockedByList: boolean;
  readonly notFound: boolean;
};

export type RelationshipEntry = {
  readonly actor: RelationshipNode;
  readonly other: RelationshipNode;
  readonly relationship: RelationshipEdge;
};

export type RelationshipGraphResult = {
  readonly graph: Graph.DirectedGraph<RelationshipNode, RelationshipEdge>;
  readonly actorIndex: Graph.NodeIndex;
  readonly nodeIndexByKey: Map<string, Graph.NodeIndex>;
};

const edgeFromRelationship = (relationship: RelationshipView): RelationshipEdge => {
  if (!("did" in relationship)) {
    return {
      following: false,
      followedBy: false,
      mutual: false,
      blocking: false,
      blockedBy: false,
      blockingByList: false,
      blockedByList: false,
      notFound: true
    };
  }
  const following = typeof relationship.following === "string";
  const followedBy = typeof relationship.followedBy === "string";
  const blocking = typeof relationship.blocking === "string";
  const blockedBy = typeof relationship.blockedBy === "string";
  const blockingByList = typeof relationship.blockingByList === "string";
  const blockedByList = typeof relationship.blockedByList === "string";
  return {
    following,
    followedBy,
    mutual: following && followedBy,
    blocking,
    blockedBy,
    blockingByList,
    blockedByList,
    notFound: false
  };
};

const nodeFromKey = (key: string): RelationshipNode => ({
  ...(key.startsWith("did:") ? { did: key } : {}),
  inputs: [key],
  notFound: true
});

export const buildRelationshipGraph = (
  actorKey: string,
  nodesByKey: Map<string, RelationshipNode>,
  relationships: ReadonlyArray<RelationshipView>
): RelationshipGraphResult => {
  const base = Graph.directed<RelationshipNode, RelationshipEdge>();
  const nodeIndexByKey = new Map<string, Graph.NodeIndex>();
  const nodeLookup = new Map<string, RelationshipNode>();
  for (const [key, node] of nodesByKey.entries()) {
    if (!nodeLookup.has(key)) {
      nodeLookup.set(key, node);
    }
    for (const input of node.inputs) {
      if (!nodeLookup.has(input)) {
        nodeLookup.set(input, node);
      }
    }
  }

  let actorIndex: Graph.NodeIndex | undefined;
  const graph = Graph.mutate(base, (mutable) => {
    const ensureNode = (key: string) => {
      const node = nodeLookup.get(key) ?? nodeFromKey(key);
      const canonicalKey = node.did ?? key;
      const existing = nodeIndexByKey.get(canonicalKey);
      if (existing !== undefined) {
        nodeIndexByKey.set(key, existing);
        for (const input of node.inputs) {
          nodeIndexByKey.set(input, existing);
        }
        return existing;
      }
      const index = Graph.addNode(mutable, node);
      nodeIndexByKey.set(canonicalKey, index);
      nodeIndexByKey.set(key, index);
      for (const input of node.inputs) {
        nodeIndexByKey.set(input, index);
      }
      return index;
    };

    actorIndex = ensureNode(actorKey);

    for (const relationship of relationships) {
      const key = "did" in relationship ? relationship.did : relationship.actor;
      const otherIndex = ensureNode(key);
      Graph.addEdge(mutable, actorIndex, otherIndex, edgeFromRelationship(relationship));
    }
  });

  if (actorIndex === undefined) {
    throw new Error(`Missing actor node for ${actorKey}`);
  }

  return { graph, actorIndex, nodeIndexByKey };
};

export const relationshipEntries = (
  graph: Graph.DirectedGraph<RelationshipNode, RelationshipEdge>
): ReadonlyArray<RelationshipEntry> => {
  const edges = Array.from(Graph.values(Graph.edges(graph)));
  const entries: RelationshipEntry[] = [];
  for (const edge of edges) {
    const actor = Option.getOrUndefined(Graph.getNode(graph, edge.source));
    const other = Option.getOrUndefined(Graph.getNode(graph, edge.target));
    if (!actor || !other) {
      continue;
    }
    entries.push({ actor, other, relationship: edge.data });
  }
  return entries;
};

export const relationshipMermaid = (
  graph: Graph.DirectedGraph<RelationshipNode, RelationshipEdge>
): string => Graph.toMermaid(graph);

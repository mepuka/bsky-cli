import { Graph, Option, Order } from "effect";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../domain/graph.js";
import { graphFromSnapshot } from "./snapshot.js";

export type Community = {
  readonly id: string;
  readonly members: ReadonlyArray<GraphNode>;
};

export type CommunityOptions = {
  readonly iterations?: number;
  readonly minSize?: number;
  readonly weighted?: boolean;
};

const communityOrder = Order.make<Community>((left, right) => {
  if (left.members.length < right.members.length) return 1;
  if (left.members.length > right.members.length) return -1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
});

const nodeOrder = Order.make<GraphNode>((left, right) => {
  const leftId = String(left.id);
  const rightId = String(right.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
});

const neighborLabelScores = (
  graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>,
  labels: Map<Graph.NodeIndex, Graph.NodeIndex>,
  node: Graph.NodeIndex,
  weighted: boolean
) => {
  const scores = new Map<Graph.NodeIndex, number>();
  const addScore = (neighbor: Graph.NodeIndex, weight: number) => {
    const label = labels.get(neighbor) ?? neighbor;
    scores.set(label, (scores.get(label) ?? 0) + weight);
  };

  const collectEdges = (edgeIndices: ReadonlyArray<Graph.EdgeIndex>, useTarget: boolean) => {
    for (const edgeIndex of edgeIndices) {
      const edge = graph.edges.get(edgeIndex);
      if (!edge) continue;
      const neighbor = useTarget ? edge.target : edge.source;
      const weight = weighted ? edge.data.weight ?? 1 : 1;
      addScore(neighbor, weight);
    }
  };

  const outgoing = graph.adjacency.get(node) ?? [];
  collectEdges(outgoing, true);

  if (graph.type === "directed") {
    const incoming = graph.reverseAdjacency.get(node) ?? [];
    collectEdges(incoming, false);
  }

  return scores;
};

const chooseLabel = (scores: Map<Graph.NodeIndex, number>, current: Graph.NodeIndex) => {
  if (scores.size === 0) return current;
  let selected = current;
  let bestScore = -1;
  for (const [label, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      selected = label;
      continue;
    }
    if (score === bestScore && label < selected) {
      selected = label;
    }
  }
  return selected;
};

export const detectCommunities = (
  graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>,
  options?: CommunityOptions
): ReadonlyArray<Community> => {
  const iterations = options?.iterations ?? 10;
  const minSize = options?.minSize ?? 1;
  const weighted = options?.weighted ?? false;
  const nodes = Array.from(Graph.indices(Graph.nodes(graph)));
  const labels = new Map<Graph.NodeIndex, Graph.NodeIndex>();

  nodes.forEach((node) => labels.set(node, node));

  for (let i = 0; i < iterations; i += 1) {
    let changed = false;
    for (const node of nodes) {
      const scores = neighborLabelScores(graph, labels, node, weighted);
      const current = labels.get(node) ?? node;
      const next = chooseLabel(scores, current);
      if (next !== current) {
        labels.set(node, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<Graph.NodeIndex, Array<GraphNode>>();
  for (const [nodeIndex, label] of labels.entries()) {
    const node = Option.getOrUndefined(Graph.getNode(graph, nodeIndex));
    if (!node) continue;
    const entry = groups.get(label) ?? [];
    entry.push(node);
    groups.set(label, entry);
  }

  const communities: Community[] = [];
  for (const members of groups.values()) {
    const sorted = members.sort(nodeOrder);
    if (sorted.length < minSize) continue;
    const id = sorted[0] ? String(sorted[0].id) : "";
    communities.push({ id, members: sorted });
  }

  return communities.sort(communityOrder);
};

export const communitiesFromSnapshot = (
  snapshot: GraphSnapshot,
  options?: CommunityOptions
): ReadonlyArray<Community> => detectCommunities(graphFromSnapshot(snapshot).graph, options);

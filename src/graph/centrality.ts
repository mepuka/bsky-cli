import { Graph, Option, Order } from "effect";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../domain/graph.js";

export type DegreeDirection = "in" | "out" | "both";

export type CentralityEntry = {
  readonly node: GraphNode;
  readonly score: number;
};

export type PageRankOptions = {
  readonly damping?: number;
  readonly iterations?: number;
  readonly weighted?: boolean;
};

export type DegreeOptions = {
  readonly direction?: DegreeDirection;
  readonly weighted?: boolean;
};

export const graphFromSnapshot = (
  snapshot: GraphSnapshot
): {
  readonly graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>;
  readonly nodeIndexById: Map<string, Graph.NodeIndex>;
} => {
  const base = snapshot.directed
    ? Graph.directed<GraphNode, GraphEdge>()
    : Graph.undirected<GraphNode, GraphEdge>();
  const nodeIndexById = new Map<string, Graph.NodeIndex>();
  const graph = Graph.mutate(base, (mutable) => {
    for (const node of snapshot.nodes) {
      const index = Graph.addNode(mutable, node);
      nodeIndexById.set(String(node.id), index);
    }
    for (const edge of snapshot.edges) {
      const source = nodeIndexById.get(String(edge.from));
      const target = nodeIndexById.get(String(edge.to));
      if (source === undefined || target === undefined) {
        continue;
      }
      Graph.addEdge(mutable, source, target, edge);
    }
  });
  return { graph, nodeIndexById };
};

const scoreOrder = Order.make<CentralityEntry>((left, right) => {
  if (left.score < right.score) return 1;
  if (left.score > right.score) return -1;
  const leftId = String(left.node.id);
  const rightId = String(right.node.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
});

const toEntries = (
  graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>,
  scores: Map<Graph.NodeIndex, number>
) => {
  const entries: CentralityEntry[] = [];
  for (const [index, score] of scores.entries()) {
    const node = Option.getOrUndefined(Graph.getNode(graph, index));
    if (!node) continue;
    entries.push({ node, score });
  }
  return entries.sort(scoreOrder);
};

export const degreeCentrality = (
  graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>,
  options?: DegreeOptions
): ReadonlyArray<CentralityEntry> => {
  const direction = options?.direction ?? "both";
  const weighted = options?.weighted ?? false;
  const scores = new Map<Graph.NodeIndex, number>();

  for (const index of Graph.indices(Graph.nodes(graph))) {
    scores.set(index, 0);
  }

  if (weighted) {
    for (const edge of Graph.values(Graph.edges(graph))) {
      const weight = edge.data.weight ?? 1;
      if (direction === "out" || direction === "both") {
        scores.set(edge.source, (scores.get(edge.source) ?? 0) + weight);
      }
      if (direction === "in" || direction === "both") {
        scores.set(edge.target, (scores.get(edge.target) ?? 0) + weight);
      }
    }
    return toEntries(graph, scores);
  }

  for (const index of Graph.indices(Graph.nodes(graph))) {
    const neighborsOut = graph.type === "directed"
      ? Graph.neighborsDirected(graph, index, "outgoing")
      : Graph.neighbors(graph, index);
    const neighborsIn = graph.type === "directed"
      ? Graph.neighborsDirected(graph, index, "incoming")
      : neighborsOut;
    const score = direction === "out"
      ? neighborsOut.length
      : direction === "in"
        ? neighborsIn.length
        : neighborsOut.length + neighborsIn.length;
    scores.set(index, score);
  }

  return toEntries(graph, scores);
};

export const pageRankCentrality = (
  graph: Graph.Graph<GraphNode, GraphEdge, Graph.Kind>,
  options?: PageRankOptions
): ReadonlyArray<CentralityEntry> => {
  const damping = options?.damping ?? 0.85;
  const iterations = options?.iterations ?? 20;
  const weighted = options?.weighted ?? false;

  const nodes = Array.from(Graph.indices(Graph.nodes(graph)));
  const count = nodes.length;
  if (count === 0) return [];

  const indexOf = new Map<Graph.NodeIndex, number>();
  nodes.forEach((node, idx) => indexOf.set(node, idx));

  const incoming: Array<Array<{ readonly source: number; readonly weight: number }>> =
    Array.from({ length: count }, () => []);
  const outWeight = new Array<number>(count).fill(0);

  for (const edge of Graph.values(Graph.edges(graph))) {
    const sourceIndex = indexOf.get(edge.source);
    const targetIndex = indexOf.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) {
      continue;
    }
    const weight = weighted ? edge.data.weight ?? 1 : 1;
    const currentOut = outWeight[sourceIndex] ?? 0;
    outWeight[sourceIndex] = currentOut + weight;
    const incomingList = incoming[targetIndex];
    if (incomingList) {
      incomingList.push({ source: sourceIndex, weight });
    }
  }

  let ranks = new Array<number>(count).fill(1 / count);

  for (let i = 0; i < iterations; i += 1) {
    const next = new Array<number>(count).fill((1 - damping) / count);
    let danglingSum = 0;
    for (let idx = 0; idx < count; idx += 1) {
      if (outWeight[idx] === 0) {
        danglingSum += ranks[idx] ?? 0;
      }
    }
    const danglingShare = damping * danglingSum / count;
    for (let idx = 0; idx < count; idx += 1) {
      next[idx] = (next[idx] ?? 0) + danglingShare;
    }
    for (let target = 0; target < count; target += 1) {
      const edgesIn = incoming[target] ?? [];
      let sum = 0;
      for (const edge of edgesIn) {
        const denom = outWeight[edge.source] ?? 0;
        if (denom > 0) {
          sum += (ranks[edge.source] ?? 0) * (edge.weight / denom);
        }
      }
      next[target] = (next[target] ?? 0) + damping * sum;
    }
    ranks = next;
  }

  const scores = new Map<Graph.NodeIndex, number>();
  nodes.forEach((node, idx) => {
    scores.set(node, ranks[idx] ?? 0);
  });

  return toEntries(graph, scores);
};

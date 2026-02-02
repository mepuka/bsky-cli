import { Graph } from "effect";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../domain/graph.js";

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

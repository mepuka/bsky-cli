import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { GraphEdge, GraphNode, GraphSnapshot } from "../../src/domain/graph.js";
import { degreeCentrality, graphFromSnapshot, pageRankCentrality } from "../../src/graph/centrality.js";

const didA = "did:plc:alice";
const didB = "did:plc:bob";
const didC = "did:plc:carol";

const nodeA = Schema.decodeUnknownSync(GraphNode)({ id: didA, label: "alice" });
const nodeB = Schema.decodeUnknownSync(GraphNode)({ id: didB, label: "bob" });
const nodeC = Schema.decodeUnknownSync(GraphNode)({ id: didC, label: "carol" });

const edges = [
  Schema.decodeUnknownSync(GraphEdge)({ from: didA, to: didB, type: "mention", weight: 2 }),
  Schema.decodeUnknownSync(GraphEdge)({ from: didB, to: didC, type: "reply", weight: 1 }),
  Schema.decodeUnknownSync(GraphEdge)({ from: didC, to: didB, type: "reply", weight: 1 })
];

const snapshot = Schema.decodeUnknownSync(GraphSnapshot)({
  nodes: [nodeA, nodeB, nodeC],
  edges,
  directed: true,
  builtAt: new Date("2026-02-02T00:00:00.000Z"),
  sources: ["store:test"]
});

describe("graph centrality", () => {
  test("degree centrality honors direction and weights", () => {
    const { graph } = graphFromSnapshot(snapshot);
    const outWeighted = degreeCentrality(graph, { direction: "out", weighted: true });
    expect(String(outWeighted[0]?.node.id)).toBe(didA);
    expect(outWeighted[0]?.score).toBe(2);

    const inWeighted = degreeCentrality(graph, { direction: "in", weighted: true });
    expect(String(inWeighted[0]?.node.id)).toBe(didB);
    expect(inWeighted[0]?.score).toBe(3);
  });

  test("pagerank favors nodes with more incoming weight", () => {
    const { graph } = graphFromSnapshot(snapshot);
    const ranks = pageRankCentrality(graph, { iterations: 25, weighted: true });
    expect(String(ranks[0]?.node.id)).toBe(didB);
  });
});

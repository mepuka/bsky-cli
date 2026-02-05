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

const undirectedSnapshot = Schema.decodeUnknownSync(GraphSnapshot)({
  nodes: [nodeA, nodeB, nodeC],
  edges,
  directed: false,
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

describe("undirected graph centrality", () => {
  test("unweighted degree with direction 'both' does not double-count", () => {
    const { graph } = graphFromSnapshot(undirectedSnapshot);
    const result = degreeCentrality(graph, { direction: "both", weighted: false });
    const byId = new Map(result.map((e) => [String(e.node.id), e.score]));
    // alice has 1 neighbor (bob), bob has 2 (alice, carol), carol has 1 (bob)
    expect(byId.get(didA)).toBe(1);
    expect(byId.get(didB)).toBe(2);
    expect(byId.get(didC)).toBe(1);
  });

  test("weighted degree with 'in' and 'out' produce identical scores for undirected", () => {
    const { graph } = graphFromSnapshot(undirectedSnapshot);
    const inResult = degreeCentrality(graph, { direction: "in", weighted: true });
    const outResult = degreeCentrality(graph, { direction: "out", weighted: true });
    const inById = new Map(inResult.map((e) => [String(e.node.id), e.score]));
    const outById = new Map(outResult.map((e) => [String(e.node.id), e.score]));
    // Direction is meaningless for undirected graphs — scores must match
    expect(inById.get(didA)).toBe(outById.get(didA));
    expect(inById.get(didB)).toBe(outById.get(didB));
    expect(inById.get(didC)).toBe(outById.get(didC));
  });

  test("weighted degree with 'both' computes correct total weight for undirected", () => {
    const { graph } = graphFromSnapshot(undirectedSnapshot);
    const result = degreeCentrality(graph, { direction: "both", weighted: true });
    const byId = new Map(result.map((e) => [String(e.node.id), e.score]));
    // Edges: A-B(2), B-C(1), C-B(1). Each edge adds weight to both endpoints.
    // alice: 2, bob: 2+1+1=4, carol: 1+1=2
    expect(byId.get(didA)).toBe(2);
    expect(byId.get(didB)).toBe(4);
    expect(byId.get(didC)).toBe(2);
  });
});

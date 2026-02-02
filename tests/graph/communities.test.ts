import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { GraphEdge, GraphNode, GraphSnapshot } from "../../src/domain/graph.js";
import { communitiesFromSnapshot } from "../../src/graph/communities.js";

const didA = "did:plc:alice";
const didB = "did:plc:bob";
const didC = "did:plc:carol";
const didD = "did:plc:dave";
const didE = "did:plc:erin";

const nodes = [
  Schema.decodeUnknownSync(GraphNode)({ id: didA, label: "alice" }),
  Schema.decodeUnknownSync(GraphNode)({ id: didB, label: "bob" }),
  Schema.decodeUnknownSync(GraphNode)({ id: didC, label: "carol" }),
  Schema.decodeUnknownSync(GraphNode)({ id: didD, label: "dave" }),
  Schema.decodeUnknownSync(GraphNode)({ id: didE, label: "erin" })
];

const edges = [
  Schema.decodeUnknownSync(GraphEdge)({ from: didA, to: didB, type: "mention" }),
  Schema.decodeUnknownSync(GraphEdge)({ from: didB, to: didA, type: "mention" }),
  Schema.decodeUnknownSync(GraphEdge)({ from: didC, to: didD, type: "reply" }),
  Schema.decodeUnknownSync(GraphEdge)({ from: didD, to: didC, type: "reply" })
];

const snapshot = Schema.decodeUnknownSync(GraphSnapshot)({
  nodes,
  edges,
  directed: true,
  builtAt: new Date("2026-02-02T00:00:00.000Z"),
  sources: ["store:test"]
});

describe("graph communities", () => {
  test("detects disconnected communities", () => {
    const communities = communitiesFromSnapshot(snapshot, { iterations: 10, minSize: 1 });
    const sizes = communities.map((community) => community.members.length);
    expect(sizes).toContain(2);
    expect(sizes).toContain(2);
  });

  test("minSize filters singleton communities", () => {
    const communities = communitiesFromSnapshot(snapshot, { iterations: 10, minSize: 2 });
    const ids = communities.flatMap((community) => community.members.map((member) => String(member.id)));
    expect(ids.includes(didE)).toBe(false);
  });
});

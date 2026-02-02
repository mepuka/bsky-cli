import { describe, expect, test } from "bun:test";
import { Relationship, NotFoundActor } from "../../src/domain/bsky.js";
import {
  buildRelationshipGraph,
  relationshipEntries
} from "../../src/graph/relationships.js";

describe("relationship graph", () => {
  test("derives mutual relationships", () => {
    const nodesByKey = new Map([
      ["did:plc:actor", { did: "did:plc:actor", inputs: ["actor"] }],
      ["did:plc:other", { did: "did:plc:other", inputs: ["other"] }]
    ]);
    const relationship = Relationship.make({
      did: "did:plc:other",
      following: "at://did:plc:actor/app.bsky.graph.follow/1",
      followedBy: "at://did:plc:other/app.bsky.graph.follow/2"
    });
    const { graph } = buildRelationshipGraph(
      "did:plc:actor",
      nodesByKey,
      [relationship]
    );
    const entries = relationshipEntries(graph);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.relationship.mutual).toBe(true);
  });

  test("marks not found relationships", () => {
    const nodesByKey = new Map([
      ["did:plc:actor", { did: "did:plc:actor", inputs: ["actor"] }]
    ]);
    const relationship = NotFoundActor.make({
      actor: "missing.example",
      notFound: true
    });
    const { graph } = buildRelationshipGraph(
      "did:plc:actor",
      nodesByKey,
      [relationship]
    );
    const entries = relationshipEntries(graph);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.other.notFound).toBe(true);
    expect(entries[0]?.relationship.notFound).toBe(true);
  });

  test("normalizes handle inputs to DID nodes", () => {
    const nodesByKey = new Map([
      ["did:plc:actor", { did: "did:plc:actor", inputs: ["alice.bsky"] }],
      ["did:plc:other", { did: "did:plc:other", inputs: ["bob.bsky"] }]
    ]);
    const relationship = Relationship.make({
      did: "did:plc:other",
      following: "at://did:plc:actor/app.bsky.graph.follow/1"
    });
    const result = buildRelationshipGraph(
      "alice.bsky",
      nodesByKey,
      [relationship]
    );
    expect(result.nodeIndexByKey.get("alice.bsky")).toBe(
      result.nodeIndexByKey.get("did:plc:actor")
    );
  });
});

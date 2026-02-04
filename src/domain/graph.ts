import { Schema } from "effect";
import { Did, Timestamp } from "./primitives.js";

export const GraphEdgeType = Schema.Literal(
  "reply",
  "quote",
  "repost",
  "mention",
  "follow",
  "block",
  "mute",
  "derived-from",
  "shared-author"
);
export type GraphEdgeType = typeof GraphEdgeType.Type;

const GraphMeta = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export class GraphNode extends Schema.Class<GraphNode>("GraphNode")({
  id: Did,
  label: Schema.optional(Schema.String),
  meta: Schema.optional(GraphMeta)
}) {}

export class GraphEdge extends Schema.Class<GraphEdge>("GraphEdge")({
  from: Did,
  to: Did,
  type: GraphEdgeType,
  weight: Schema.optional(Schema.Number),
  meta: Schema.optional(GraphMeta)
}) {}

export class GraphSummary extends Schema.Class<GraphSummary>("GraphSummary")({
  postsScanned: Schema.Int,
  interactionsByType: Schema.Record({ key: Schema.String, value: Schema.Int }),
  uniqueActors: Schema.Int,
  edgeCount: Schema.Int,
  density: Schema.Number
}) {}

export class GraphSnapshot extends Schema.Class<GraphSnapshot>("GraphSnapshot")({
  nodes: Schema.Array(GraphNode),
  edges: Schema.Array(GraphEdge),
  directed: Schema.Boolean,
  builtAt: Timestamp,
  sources: Schema.Array(Schema.String),
  window: Schema.optional(Schema.Struct({ start: Timestamp, end: Timestamp })),
  filters: Schema.optional(Schema.Struct({ filterHash: Schema.optional(Schema.String) })),
  summary: Schema.optional(GraphSummary)
}) {}

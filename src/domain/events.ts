import { Schema } from "effect";
import { Post } from "./post.js";
import { LlmDecisionMeta } from "./llm.js";
import { EventId, PostCid, PostUri, Timestamp } from "./primitives.js";
import { FilterExprSchema } from "./filter.js";

export class EventMeta extends Schema.Class<EventMeta>("EventMeta")({
  source: Schema.Literal("timeline", "notifications", "jetstream", "feed"),
  command: Schema.String,
  filterExprHash: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  promptHash: Schema.optional(Schema.String),
  llm: Schema.optional(Schema.Array(LlmDecisionMeta)),
  createdAt: Timestamp
}) {}

export class PostUpsert extends Schema.TaggedClass<PostUpsert>()("PostUpsert", {
  post: Post,
  meta: EventMeta
}) {}

export class PostDelete extends Schema.TaggedClass<PostDelete>()("PostDelete", {
  uri: PostUri,
  cid: Schema.optional(PostCid),
  meta: EventMeta
}) {}

export const PostEvent = Schema.Union(PostUpsert, PostDelete);
export type PostEvent = typeof PostEvent.Type;

export class PostEventRecord extends Schema.Class<PostEventRecord>("PostEventRecord")({
  id: EventId,
  version: Schema.Literal(1),
  event: PostEvent
}) {}

export class StoreQuery extends Schema.Class<StoreQuery>("StoreQuery")({
  range: Schema.optional(Schema.Struct({ start: Timestamp, end: Timestamp })),
  filter: Schema.optional(FilterExprSchema),
  limit: Schema.optional(Schema.Number)
}) {}

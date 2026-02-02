import { Schema } from "effect";
import { Post } from "./post.js";
import { EventId, EventSeq, PostCid, PostUri, Timestamp, StoreName } from "./primitives.js";
import { FilterExprSchema } from "./filter.js";

export const StoreQueryOrder = Schema.Literal("asc", "desc");
export type StoreQueryOrder = typeof StoreQueryOrder.Type;

export const StoreQuerySort = Schema.Literal(
  "createdAt",
  "likeCount",
  "repostCount",
  "replyCount",
  "quoteCount",
  "engagement"
);
export type StoreQuerySort = typeof StoreQuerySort.Type;

export class EventMeta extends Schema.Class<EventMeta>("EventMeta")({
  source: Schema.Literal(
    "timeline",
    "notifications",
    "jetstream",
    "feed",
    "list",
    "author",
    "thread"
  ),
  command: Schema.String,
  filterExprHash: Schema.optional(Schema.String),
  createdAt: Timestamp,
  sourceStore: Schema.optional(StoreName)
}) {}

export class PostUpsert extends Schema.TaggedClass<PostUpsert>()("PostUpsert", {
  post: Post,
  meta: EventMeta
}) {}
export const isPostUpsert = Schema.is(PostUpsert);

export class PostDelete extends Schema.TaggedClass<PostDelete>()("PostDelete", {
  uri: PostUri,
  cid: Schema.optional(PostCid),
  meta: EventMeta
}) {}
export const isPostDelete = Schema.is(PostDelete);

export const PostEvent = Schema.Union(PostUpsert, PostDelete);
export type PostEvent = typeof PostEvent.Type;

export class PostEventRecord extends Schema.Class<PostEventRecord>("PostEventRecord")({
  id: EventId,
  version: Schema.Literal(1),
  event: PostEvent
}) {}

export type EventLogEntry = {
  readonly seq: EventSeq;
  readonly record: PostEventRecord;
};

export class StoreQuery extends Schema.Class<StoreQuery>("StoreQuery")({
  range: Schema.optional(Schema.Struct({ start: Timestamp, end: Timestamp })),
  filter: Schema.optional(FilterExprSchema),
  scanLimit: Schema.optional(Schema.NonNegativeInt),
  sortBy: Schema.optional(StoreQuerySort),
  order: Schema.optional(StoreQueryOrder)
}) {}

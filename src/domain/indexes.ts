import { Schema } from "effect";
import { EventSeq, Handle, Hashtag, PostUri, Timestamp } from "./primitives.js";

export class PostIndexEntry extends Schema.Class<PostIndexEntry>("PostIndexEntry")({
  uri: PostUri,
  createdDate: Schema.String,
  hashtags: Schema.Array(Hashtag),
  author: Schema.optional(Handle)
}) {}

export class IndexCheckpoint extends Schema.Class<IndexCheckpoint>("IndexCheckpoint")({
  index: Schema.String,
  version: Schema.NonNegativeInt,
  lastEventSeq: EventSeq,
  eventCount: Schema.NonNegativeInt,
  updatedAt: Timestamp
}) {}

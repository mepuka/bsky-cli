import { Schema } from "effect";
import { EventId, Hashtag, PostUri, Timestamp } from "./primitives.js";

export class PostIndexEntry extends Schema.Class<PostIndexEntry>("PostIndexEntry")({
  uri: PostUri,
  createdDate: Schema.String,
  hashtags: Schema.Array(Hashtag)
}) {}

export class IndexCheckpoint extends Schema.Class<IndexCheckpoint>("IndexCheckpoint")({
  index: Schema.String,
  version: Schema.NonNegativeInt,
  lastEventId: EventId,
  eventCount: Schema.NonNegativeInt,
  updatedAt: Timestamp
}) {}

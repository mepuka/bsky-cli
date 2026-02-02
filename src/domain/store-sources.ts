import { Schema } from "effect";
import { AtUri, Did, Handle, Timestamp } from "./primitives.js";

export class AuthorSource extends Schema.TaggedClass<AuthorSource>()("AuthorSource", {
  actor: Did,
  display: Schema.optional(Handle),
  filter: Schema.optional(Schema.String),
  postFilter: Schema.optional(Schema.String),
  postFilterJson: Schema.optional(Schema.String),
  addedAt: Timestamp,
  lastSyncedAt: Schema.optional(Timestamp),
  enabled: Schema.Boolean
}) {}

export class FeedSource extends Schema.TaggedClass<FeedSource>()("FeedSource", {
  uri: AtUri,
  filter: Schema.optional(Schema.String),
  filterJson: Schema.optional(Schema.String),
  addedAt: Timestamp,
  lastSyncedAt: Schema.optional(Timestamp),
  enabled: Schema.Boolean
}) {}

export class ListSource extends Schema.TaggedClass<ListSource>()("ListSource", {
  uri: AtUri,
  filter: Schema.optional(Schema.String),
  filterJson: Schema.optional(Schema.String),
  expandMembers: Schema.Boolean,
  addedAt: Timestamp,
  lastSyncedAt: Schema.optional(Timestamp),
  enabled: Schema.Boolean
}) {}

export class TimelineSource extends Schema.TaggedClass<TimelineSource>()("TimelineSource", {
  addedAt: Timestamp,
  lastSyncedAt: Schema.optional(Timestamp),
  enabled: Schema.Boolean
}) {}

export class JetstreamSource extends Schema.TaggedClass<JetstreamSource>()("JetstreamSource", {
  addedAt: Timestamp,
  lastSyncedAt: Schema.optional(Timestamp),
  enabled: Schema.Boolean
}) {}

export const StoreSourceSchema = Schema.Union(
  AuthorSource,
  FeedSource,
  ListSource,
  TimelineSource,
  JetstreamSource
);
export type StoreSource = typeof StoreSourceSchema.Type;

export const storeSourceKey = (tag: StoreSource["_tag"], value: string) =>
  `${tag}:${value}`;

export const storeSourceId = (source: StoreSource) => {
  switch (source._tag) {
    case "AuthorSource":
      return storeSourceKey(source._tag, source.actor);
    case "FeedSource":
      return storeSourceKey(source._tag, source.uri);
    case "ListSource":
      return storeSourceKey(source._tag, source.uri);
    case "TimelineSource":
      return storeSourceKey(source._tag, "timeline");
    case "JetstreamSource":
      return storeSourceKey(source._tag, "jetstream");
  }
};

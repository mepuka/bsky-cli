import { Match, Schema } from "effect";
import * as Monoid from "@effect/typeclass/Monoid";
import * as Semigroup from "@effect/typeclass/Semigroup";
import { MonoidSum } from "@effect/typeclass/data/Number";
import { AuthorFeedFilter } from "./bsky.js";
import { FilterExprSchema } from "./filter.js";
import { StoreRef, SyncUpsertPolicy } from "./store.js";
import { EventSeq, StoreName, Timestamp } from "./primitives.js";

export const SyncStage = Schema.Literal("source", "parse", "filter", "store");
export type SyncStage = typeof SyncStage.Type;

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
  stage: SyncStage,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class SyncResult extends Schema.Class<SyncResult>("SyncResult")({
  postsAdded: Schema.Number,
  postsDeleted: Schema.Number,
  postsSkipped: Schema.Number,
  errors: Schema.Array(SyncError)
}) {}

const SyncResultErrorsMonoid = Monoid.array<SyncError>();

const SyncResultSemigroup: Semigroup.Semigroup<SyncResult> = Semigroup.make(
  (left, right) =>
    SyncResult.make({
      postsAdded: MonoidSum.combine(left.postsAdded, right.postsAdded),
      postsDeleted: MonoidSum.combine(left.postsDeleted, right.postsDeleted),
      postsSkipped: MonoidSum.combine(left.postsSkipped, right.postsSkipped),
      errors: SyncResultErrorsMonoid.combine(left.errors, right.errors)
    })
);

export const SyncResultMonoid: Monoid.Monoid<SyncResult> = Monoid.fromSemigroup(
  SyncResultSemigroup,
  SyncResult.make({
    postsAdded: MonoidSum.empty,
    postsDeleted: MonoidSum.empty,
    postsSkipped: MonoidSum.empty,
    errors: SyncResultErrorsMonoid.empty
  })
);

export class DataSourceTimeline extends Schema.TaggedClass<DataSourceTimeline>()(
  "Timeline",
  {}
) {}

export class DataSourceFeed extends Schema.TaggedClass<DataSourceFeed>()("Feed", {
  uri: Schema.String
}) {}

export class DataSourceList extends Schema.TaggedClass<DataSourceList>()("List", {
  uri: Schema.String
}) {}

export class DataSourceNotifications extends Schema.TaggedClass<DataSourceNotifications>()(
  "Notifications",
  {}
) {}

export class DataSourceAuthor extends Schema.TaggedClass<DataSourceAuthor>()("Author", {
  actor: Schema.String,
  filter: Schema.optional(AuthorFeedFilter),
  includePins: Schema.optional(Schema.Boolean)
}) {}

export class DataSourceThread extends Schema.TaggedClass<DataSourceThread>()("Thread", {
  uri: Schema.String,
  depth: Schema.optional(Schema.NonNegativeInt),
  parentHeight: Schema.optional(Schema.NonNegativeInt)
}) {}

export class DataSourceJetstream extends Schema.TaggedClass<DataSourceJetstream>()(
  "Jetstream",
  {
    endpoint: Schema.optional(Schema.String),
    collections: Schema.optional(Schema.Array(Schema.String)),
    dids: Schema.optional(Schema.Array(Schema.String)),
    compress: Schema.optional(Schema.Boolean),
    maxMessageSizeBytes: Schema.optional(Schema.Number)
  }
) {}

export const DataSourceSchema = Schema.Union(
  DataSourceTimeline,
  DataSourceFeed,
  DataSourceList,
  DataSourceNotifications,
  DataSourceAuthor,
  DataSourceThread,
  DataSourceJetstream
);
export type DataSource = typeof DataSourceSchema.Type;

export const DataSource = {
  timeline: (): DataSource => DataSourceTimeline.make({}),
  feed: (uri: string): DataSource => DataSourceFeed.make({ uri }),
  list: (uri: string): DataSource => DataSourceList.make({ uri }),
  notifications: (): DataSource => DataSourceNotifications.make({}),
  author: (
    actor: string,
    options?: {
      readonly filter?: AuthorFeedFilter;
      readonly includePins?: boolean;
    }
  ): DataSource =>
    DataSourceAuthor.make({
      actor,
      filter: options?.filter,
      includePins: options?.includePins
    }),
  thread: (
    uri: string,
    options?: {
      readonly depth?: number;
      readonly parentHeight?: number;
    }
  ): DataSource =>
    DataSourceThread.make({
      uri,
      depth: options?.depth,
      parentHeight: options?.parentHeight
    }),
  jetstream: (options?: {
    readonly endpoint?: string;
    readonly collections?: ReadonlyArray<string>;
    readonly dids?: ReadonlyArray<string>;
    readonly compress?: boolean;
    readonly maxMessageSizeBytes?: number;
  }): DataSource =>
    DataSourceJetstream.make({
      endpoint: options?.endpoint,
      collections: options?.collections ? [...options.collections] : undefined,
      dids: options?.dids ? [...options.dids] : undefined,
      compress: options?.compress,
      maxMessageSizeBytes: options?.maxMessageSizeBytes
    })
};

export class WatchConfig extends Schema.Class<WatchConfig>("WatchConfig")({
  source: DataSourceSchema,
  store: StoreRef,
  filter: FilterExprSchema,
  interval: Schema.optional(Schema.Duration),
  policy: Schema.optional(SyncUpsertPolicy)
}) {}

export class SyncEvent extends Schema.TaggedClass<SyncEvent>()("SyncEvent", {
  result: SyncResult
}) {}

export class SyncProgress extends Schema.Class<SyncProgress>("SyncProgress")({
  processed: Schema.NonNegativeInt,
  stored: Schema.NonNegativeInt,
  skipped: Schema.NonNegativeInt,
  deleted: Schema.optional(Schema.NonNegativeInt),
  errors: Schema.NonNegativeInt,
  elapsedMs: Schema.NonNegativeInt,
  rate: Schema.Number,
  total: Schema.optional(Schema.NonNegativeInt),
  etaMs: Schema.optional(Schema.NonNegativeInt),
  store: Schema.optional(StoreName),
  source: Schema.optional(Schema.String)
}) {}

export class SyncCheckpoint extends Schema.Class<SyncCheckpoint>("SyncCheckpoint")({
  source: DataSourceSchema,
  cursor: Schema.optional(Schema.String),
  lastEventSeq: Schema.optional(EventSeq),
  filterHash: Schema.optional(Schema.String),
  updatedAt: Timestamp
}) {}

export const dataSourceKey = (source: DataSource): string => {
  const normalizeList = (items: ReadonlyArray<string> | undefined) =>
    items && items.length > 0 ? [...items].sort().join(",") : "";

  return Match.type<DataSource>().pipe(
    Match.tagsExhaustive({
      Timeline: () => "timeline",
      Feed: (feed) => `feed:${feed.uri}`,
      List: (list) => `list:${list.uri}`,
      Notifications: () => "notifications",
      Author: (author) => {
        const filter = author.filter ?? "";
        const includePins =
          author.includePins === undefined ? "" : author.includePins ? "1" : "0";
        return `author:${encodeURIComponent(author.actor)}:${encodeURIComponent(
          filter
        )}:${includePins}`;
      },
      Thread: (thread) => {
        const depth = thread.depth ?? "";
        const parentHeight = thread.parentHeight ?? "";
        return `thread:${encodeURIComponent(thread.uri)}:${depth}:${parentHeight}`;
      },
      Jetstream: (jetstream) => {
        const endpoint = jetstream.endpoint ?? "";
        const collections = normalizeList(jetstream.collections);
        const dids = normalizeList(jetstream.dids);
        const compress = jetstream.compress ? "1" : "0";
        const maxMessageSize = jetstream.maxMessageSizeBytes ?? "";
        return `jetstream:${encodeURIComponent(endpoint)}:${encodeURIComponent(
          collections
        )}:${encodeURIComponent(dids)}:${compress}:${maxMessageSize}`;
      }
    })
  )(source);
};

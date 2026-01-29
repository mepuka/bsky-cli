/**
 * StoreIndex Service - SQLite-based Indexing for Posts
 *
 * This module provides the StoreIndex service, which manages SQLite-based indexing
 * of posts within a store. The index maintains a synchronized view of all posts
 * based on events from the StoreEventLog, enabling efficient querying, filtering,
 * and full-text search capabilities.
 *
 * ## Architecture
 *
 * The StoreIndex uses SQLite as its backing store and maintains several tables:
 * - `posts`: Main post data with JSON serialization, engagement metrics, and metadata
 * - `post_hashtag`: Many-to-many relationship for hashtags
 * - `post_lang`: Language tags for posts
 * - `posts_fts`: Full-text search index using SQLite FTS5
 * - `index_checkpoints`: Tracks indexing progress for incremental rebuilds
 *
 * ## Query Pushdown (Predicate Pushdown)
 *
 * The index implements query pushdown (also known as predicate pushdown) to optimize
 * query performance. This means filter expressions are translated into SQL WHERE clauses
 * where possible, reducing the amount of data that needs to be fetched and processed.
 *
 * The {@link PushdownExpr} type represents expressions that can be pushed down to SQLite.
 * Not all filter expressions can be pushed down (e.g., some complex predicates must be
 * evaluated in-memory), so the pushdown system identifies which constraints can be
 * handled by the database layer.
 *
 * ### Pushdown Expression Types
 *
 * - **Logical**: True, False, And, Or
 * - **Author filters**: Author (single), AuthorIn (multiple handles)
 * - **Content filters**: Hashtag, HashtagIn, Contains (text search)
 * - **Temporal filters**: DateRange (created_at bounds)
 * - **Post type filters**: IsReply, IsQuote, IsRepost, IsOriginal
 * - **Media filters**: HasLinks, HasMedia, HasImages, HasVideo
 * - **Language filters**: Language (post language matching)
 * - **Engagement filters**: Engagement (min likes/reposts/replies)
 *
 * ## Key Features
 *
 * 1. **Event-driven indexing**: Reacts to PostUpsert and PostDelete events from the event log
 * 2. **Incremental rebuilds**: Checkpoint system enables resuming indexing without reprocessing
 * 3. **Full-text search**: SQLite FTS5 integration for text search across post content
 * 4. **Efficient querying**: Pushdown predicates reduce data transfer and improve performance
 * 5. **Streaming results**: Large result sets are streamed using pagination
 * 6. **Bootstrap on first access**: Automatic index initialization when first accessed
 *
 * ## Dependencies
 *
 * - {@link StoreDb}: Provides SQLite client connections per store
 * - {@link StoreEventLog}: Source of truth for post events, used during rebuilds
 *
 * @module StoreIndex
 */

import { Chunk, Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import type { Fragment } from "@effect/sql/Statement";
import { StoreIndexError } from "../domain/errors.js";
import { PostEventRecord } from "../domain/events.js";
import type { PostEvent, StoreQuery } from "../domain/events.js";
import type { FilterExpr } from "../domain/filter.js";
import { IndexCheckpoint, PostIndexEntry } from "../domain/indexes.js";
import { EventId, Handle, PostUri, Timestamp } from "../domain/primitives.js";
import { Post } from "../domain/post.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";
import { StoreEventLog } from "./store-event-log.js";
import { deletePost, upsertPost } from "./store-index-sql.js";

const indexName = "primary";
const entryPageSize = 500;

type SearchSort = "relevance" | "newest" | "oldest";
type QueryCursorState = {
  readonly lastCreatedAt: string | undefined;
  readonly lastUri: string | undefined;
  readonly fetched: number;
};

const postUriRow = Schema.Struct({ uri: PostUri });
const postJsonRow = Schema.Struct({ post_json: Schema.String });
const postEntryRow = Schema.Struct({
  uri: PostUri,
  created_date: Schema.String,
  author: Schema.NullOr(Handle),
  hashtags: Schema.NullOr(Schema.String)
});
const checkpointRow = Schema.Struct({
  index_name: Schema.String,
  version: Schema.Number,
  last_event_id: EventId,
  event_count: Schema.Number,
  updated_at: Schema.String
});

const toStoreIndexError = (message: string) => (cause: unknown) =>
  cause instanceof StoreIndexError
    ? cause
    : StoreIndexError.make({ message, cause });

const decodePostJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(Post))(raw).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.post decode failed"))
  );

const decodeEntryRow = (row: typeof postEntryRow.Type) =>
  Schema.decodeUnknown(PostIndexEntry)({
    uri: row.uri,
    createdDate: row.created_date,
    hashtags: row.hashtags ? row.hashtags.split(",") : [],
    author: row.author ?? undefined
  }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.entry decode failed")));

const decodeCheckpointRow = (row: typeof checkpointRow.Type) =>
  Schema.decodeUnknown(IndexCheckpoint)({
    index: row.index_name,
    version: row.version,
    lastEventId: row.last_event_id,
    eventCount: row.event_count,
    updatedAt: row.updated_at
  }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.checkpoint decode failed")));

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Pushdown Expression - Represents filter predicates that can be pushed down to SQLite
 *
 * Pushdown expressions are a subset of filter expressions that can be directly
 * translated into SQL WHERE clauses. This enables the database to do the heavy
 * lifting of filtering, reducing memory usage and improving query performance.
 *
 * The expression tree is built from {@link FilterExpr} via {@link buildPushdown}
 * and then converted to SQL fragments via {@link pushdownToSql}.
 *
 * @example
 * // A complex filter becomes a pushdown expression:
 * // Author("alice") AND Hashtag("tech") ->
 * // { _tag: "And", clauses: [
 * //   { _tag: "Author", handle: "alice" },
 * //   { _tag: "Hashtag", tag: "tech" }
 * // ]}
 */
type PushdownExpr =
  /** Always true, no filtering needed */
  | { readonly _tag: "True" }
  /** Always false, returns no results */
  | { readonly _tag: "False" }
  /** Logical AND of multiple clauses */
  | { readonly _tag: "And"; readonly clauses: ReadonlyArray<PushdownExpr> }
  /** Logical OR of multiple clauses */
  | { readonly _tag: "Or"; readonly clauses: ReadonlyArray<PushdownExpr> }
  /** Filter by single author handle */
  | { readonly _tag: "Author"; readonly handle: string }
  /** Filter by multiple author handles */
  | { readonly _tag: "AuthorIn"; readonly handles: ReadonlyArray<string> }
  /** Filter by single hashtag */
  | { readonly _tag: "Hashtag"; readonly tag: string }
  /** Filter by multiple hashtags */
  | { readonly _tag: "HashtagIn"; readonly tags: ReadonlyArray<string> }
  /** Filter by creation date range (inclusive) */
  | { readonly _tag: "DateRange"; readonly start: Timestamp; readonly end: Timestamp }
  /** Filter for reply posts only */
  | { readonly _tag: "IsReply" }
  /** Filter for quote posts only */
  | { readonly _tag: "IsQuote" }
  /** Filter for reposts only */
  | { readonly _tag: "IsRepost" }
  /** Filter for original posts only (not replies, quotes, or reposts) */
  | { readonly _tag: "IsOriginal" }
  /** Filter for posts containing links */
  | { readonly _tag: "HasLinks" }
  /** Filter for posts with any media */
  | { readonly _tag: "HasMedia" }
  /** Filter for posts with images */
  | { readonly _tag: "HasImages" }
  /** Filter for posts with video */
  | { readonly _tag: "HasVideo" }
  /** Filter by post language */
  | { readonly _tag: "Language"; readonly langs: ReadonlyArray<string> }
  /** Filter by engagement metrics (likes, reposts, replies) */
  | { readonly _tag: "Engagement"; readonly minLikes?: number; readonly minReposts?: number; readonly minReplies?: number }
  /** Filter by text content (case-sensitive or insensitive) */
  | { readonly _tag: "Contains"; readonly text: string; readonly caseSensitive: boolean };

const pushdownTrue: PushdownExpr = { _tag: "True" };
const pushdownFalse: PushdownExpr = { _tag: "False" };

const simplifyAnd = (clauses: ReadonlyArray<PushdownExpr>): PushdownExpr => {
  const flattened: Array<PushdownExpr> = [];
  for (const clause of clauses) {
    if (clause._tag === "False") {
      return pushdownFalse;
    }
    if (clause._tag === "True") {
      continue;
    }
    if (clause._tag === "And") {
      flattened.push(...clause.clauses);
      continue;
    }
    flattened.push(clause);
  }
  if (flattened.length === 0) {
    return pushdownTrue;
  }
  if (flattened.length === 1) {
    return flattened[0]!;
  }
  return { _tag: "And", clauses: flattened };
};

const simplifyOr = (clauses: ReadonlyArray<PushdownExpr>): PushdownExpr => {
  const flattened: Array<PushdownExpr> = [];
  for (const clause of clauses) {
    if (clause._tag === "True") {
      return pushdownTrue;
    }
    if (clause._tag === "False") {
      continue;
    }
    if (clause._tag === "Or") {
      flattened.push(...clause.clauses);
      continue;
    }
    flattened.push(clause);
  }
  if (flattened.length === 0) {
    return pushdownFalse;
  }
  if (flattened.length === 1) {
    return flattened[0]!;
  }
  return { _tag: "Or", clauses: flattened };
};

const buildPushdown = (expr: FilterExpr | undefined): PushdownExpr => {
  if (!expr) {
    return pushdownTrue;
  }
  switch (expr._tag) {
    case "All":
      return pushdownTrue;
    case "None":
      return pushdownFalse;
    case "And":
      return simplifyAnd([buildPushdown(expr.left), buildPushdown(expr.right)]);
    case "Or":
      return simplifyOr([buildPushdown(expr.left), buildPushdown(expr.right)]);
    case "Author":
      return { _tag: "Author", handle: expr.handle };
    case "AuthorIn":
      return expr.handles.length === 0
        ? pushdownFalse
        : { _tag: "AuthorIn", handles: Array.from(new Set(expr.handles)) };
    case "Hashtag":
      return { _tag: "Hashtag", tag: expr.tag };
    case "HashtagIn":
      return expr.tags.length === 0
        ? pushdownFalse
        : { _tag: "HashtagIn", tags: Array.from(new Set(expr.tags)) };
    case "DateRange":
      return { _tag: "DateRange", start: expr.start, end: expr.end };
    case "IsReply":
      return { _tag: "IsReply" };
    case "IsQuote":
      return { _tag: "IsQuote" };
    case "IsRepost":
      return { _tag: "IsRepost" };
    case "IsOriginal":
      return { _tag: "IsOriginal" };
    case "HasLinks":
      return { _tag: "HasLinks" };
    case "HasMedia":
      return { _tag: "HasMedia" };
    case "HasImages":
      return { _tag: "HasImages" };
    case "HasVideo":
      return { _tag: "HasVideo" };
    case "Language":
      if (expr.langs.length === 0) {
        return pushdownFalse;
      }
      const langs = normalizeLangs(expr.langs);
      return langs.length === 0 ? pushdownFalse : { _tag: "Language", langs };
    case "Engagement":
      return {
        _tag: "Engagement",
        ...(expr.minLikes !== undefined ? { minLikes: expr.minLikes } : {}),
        ...(expr.minReposts !== undefined ? { minReposts: expr.minReposts } : {}),
        ...(expr.minReplies !== undefined ? { minReplies: expr.minReplies } : {})
      };
    case "Contains":
      return {
        _tag: "Contains",
        text: expr.text,
        caseSensitive: expr.caseSensitive ?? false
      };
    default:
      return pushdownTrue;
  }
};

const isAscii = (value: string) => /^[\x00-\x7F]*$/.test(value);

const normalizeLangs = (langs: ReadonlyArray<string>) =>
  Array.from(
    new Set(
      langs.map((lang) => lang.trim().toLowerCase()).filter((lang) => lang.length > 0)
    )
  );

const pushdownToSql = (
  sql: SqlClient.SqlClient,
  expr: PushdownExpr
): Fragment | undefined => {
  switch (expr._tag) {
    case "True":
      return undefined;
    case "False":
      return sql`1=0`;
    case "Author":
      return sql`p.author = ${expr.handle}`;
    case "AuthorIn":
      return expr.handles.length === 0
        ? sql`1=0`
        : sql`p.author IN ${sql.in(expr.handles)}`;
    case "Hashtag":
      return sql`EXISTS (SELECT 1 FROM post_hashtag h WHERE h.uri = p.uri AND h.tag = ${expr.tag})`;
    case "HashtagIn":
      return expr.tags.length === 0
        ? sql`1=0`
        : sql`EXISTS (SELECT 1 FROM post_hashtag h WHERE h.uri = p.uri AND h.tag IN ${sql.in(expr.tags)})`;
    case "DateRange": {
      const start = toIso(expr.start);
      const end = toIso(expr.end);
      return sql`p.created_at >= ${start} AND p.created_at <= ${end}`;
    }
    case "IsReply":
      return sql`p.is_reply = 1`;
    case "IsQuote":
      return sql`p.is_quote = 1`;
    case "IsRepost":
      return sql`p.is_repost = 1`;
    case "IsOriginal":
      return sql`p.is_original = 1`;
    case "HasLinks":
      return sql`p.has_links = 1`;
    case "HasMedia":
      return sql`p.has_media = 1`;
    case "HasImages":
      return sql`p.has_images = 1`;
    case "HasVideo":
      return sql`p.has_video = 1`;
    case "Language":
      return expr.langs.length === 0
        ? sql`1=0`
        : sql`(
            EXISTS (
              SELECT 1 FROM post_lang l
              WHERE l.uri = p.uri AND l.lang IN ${sql.in(expr.langs)}
            )
            OR (
              p.lang IS NOT NULL
              AND lower(p.lang) IN ${sql.in(expr.langs)}
            )
          )`;
    case "Engagement": {
      const clauses: Array<Fragment> = [];
      if (expr.minLikes !== undefined) {
        clauses.push(sql`p.like_count >= ${expr.minLikes}`);
      }
      if (expr.minReposts !== undefined) {
        clauses.push(sql`p.repost_count >= ${expr.minReposts}`);
      }
      if (expr.minReplies !== undefined) {
        clauses.push(sql`p.reply_count >= ${expr.minReplies}`);
      }
      if (clauses.length === 0) {
        return undefined;
      }
      return sql.and(clauses);
    }
    case "Contains": {
      const text = expr.text;
      if (text.length === 0) {
        return undefined;
      }
      if (expr.caseSensitive) {
        return sql`instr(p.text, ${text}) > 0`;
      }
      if (!isAscii(text)) {
        return undefined;
      }
      return sql`instr(lower(p.text), lower(${text})) > 0`;
    }
    case "And": {
      const clauses = expr.clauses
        .map((clause) => pushdownToSql(sql, clause))
        .filter((clause): clause is Fragment => clause !== undefined);
      if (clauses.length === 0) {
        return undefined;
      }
      return sql.and(clauses);
    }
    case "Or": {
      const clauses: Array<Fragment> = [];
      for (const clause of expr.clauses) {
        const next = pushdownToSql(sql, clause);
        if (!next) {
          return undefined;
        }
        clauses.push(next);
      }
      if (clauses.length === 0) {
        return undefined;
      }
      return sql.or(clauses);
    }
  }
};

const applyUpsert = (
  sql: SqlClient.SqlClient,
  event: Extract<PostEvent, { _tag: "PostUpsert" }>
) => upsertPost(sql, event.post);

const applyDelete = (
  sql: SqlClient.SqlClient,
  event: Extract<PostEvent, { _tag: "PostDelete" }>
) => deletePost(sql, event.uri);

/**
 * StoreIndex Service - Effect Tag and Layer for post indexing
 *
 * The StoreIndex service provides a complete indexing solution for posts within
 * a store. It maintains SQLite tables synchronized with the event log and offers
 * various querying capabilities including filtering, full-text search, and
 * streaming access to all indexed posts.
 *
 * ## Usage
 *
 * ```typescript
 * // Apply a single event to the index
 * yield* StoreIndex.apply(store, eventRecord);
 *
 * // Query posts with filters
 * const posts = yield* StoreIndex.query(store, {
 *   filter: { _tag: "Hashtag", tag: "tech" },
 *   order: "desc"
 * }).pipe(Stream.runCollect);
 *
 * // Search posts using full-text search
 * const results = yield* StoreIndex.searchPosts(store, {
 *   query: "javascript tutorial",
 *   limit: 25
 * });
 *
 * // Get checkpoint for incremental processing
 * const checkpoint = yield* StoreIndex.loadCheckpoint(store, "primary");
 * ```
 *
 * ## Automatic Bootstrap
 *
 * On first access to any store, the service automatically checks if the index
 * needs to be bootstrapped. If the posts table is empty but events exist in the
 * event log, a rebuild is triggered automatically.
 *
 * ## Checkpoint System
 *
 * Checkpoints track indexing progress, storing the last processed event ID and
 * total event count. This enables:
 * - Resuming interrupted rebuilds without reprocessing
 * - Incremental updates (process only new events since last checkpoint)
 * - Multiple index versions (tracked by index name)
 */
export class StoreIndex extends Context.Tag("@skygent/StoreIndex")<
  StoreIndex,
  {
    /**
     * Apply a single post event to the index
     *
     * Processes a PostEventRecord and updates the index accordingly:
     * - PostUpsert: Inserts or updates the post with all metadata
     * - PostDelete: Removes the post and related data from index
     *
     * @param store - Store reference to apply the event to
     * @param record - The post event record containing the event to apply
     * @returns Effect that completes when the index has been updated
     */
    readonly apply: (
      store: StoreRef,
      record: PostEventRecord
    ) => Effect.Effect<void, StoreIndexError>;

    /**
     * Get all post URIs created on a specific date
     *
     * Returns posts ordered by creation time (ascending). The date should be
     * in ISO date format (YYYY-MM-DD).
     *
     * @param store - Store reference to query
     * @param date - ISO date string (YYYY-MM-DD)
     * @returns Effect containing array of post URIs
     */
    readonly getByDate: (
      store: StoreRef,
      date: string
    ) => Effect.Effect<ReadonlyArray<PostUri>, StoreIndexError>;

    /**
     * Get all post URIs tagged with a specific hashtag
     *
     * Returns posts ordered by URI (ascending). Case-sensitive exact match.
     *
     * @param store - Store reference to query
     * @param tag - Hashtag to search for (without # prefix)
     * @returns Effect containing array of post URIs
     */
    readonly getByHashtag: (
      store: StoreRef,
      tag: string
    ) => Effect.Effect<ReadonlyArray<PostUri>, StoreIndexError>;

    /**
     * Retrieve a single post by URI
     *
     * Fetches the post JSON from the database and decodes it into a Post object.
     * Returns None if the post doesn't exist in the index.
     *
     * @param store - Store reference to query
     * @param uri - Post URI to retrieve
     * @returns Effect containing Option of Post (Some if found, None if not)
     */
    readonly getPost: (
      store: StoreRef,
      uri: PostUri
    ) => Effect.Effect<Option.Option<Post>, StoreIndexError>;

    /**
     * Check if a post URI exists in the index
     *
     * Efficient existence check using a LIMIT 1 query.
     *
     * @param store - Store reference to query
     * @param uri - Post URI to check
     * @returns Effect containing true if the URI exists, false otherwise
     */
    readonly hasUri: (
      store: StoreRef,
      uri: PostUri
    ) => Effect.Effect<boolean, StoreIndexError>;

    /**
     * Clear all indexed data for a store
     *
     * Removes all posts, hashtags, languages, and checkpoints from the index.
     * This operation is performed in a transaction for consistency.
     *
     * @param store - Store reference to clear
     * @returns Effect that completes when all data has been cleared
     */
    readonly clear: (store: StoreRef) => Effect.Effect<void, StoreIndexError>;

    /**
     * Load a checkpoint for an index
     *
     * Retrieves the stored checkpoint for a given index name, containing
     * the last processed event ID and event count. Returns None if no
     * checkpoint exists.
     *
     * @param store - Store reference to load from
     * @param index - Name of the index to load checkpoint for
     * @returns Effect containing Option of IndexCheckpoint
     */
    readonly loadCheckpoint: (
      store: StoreRef,
      index: string
    ) => Effect.Effect<Option.Option<IndexCheckpoint>, StoreIndexError>;

    /**
     * Save a checkpoint for an index
     *
     * Persists the checkpoint to the database, overwriting any existing
     * checkpoint for the same index name.
     *
     * @param store - Store reference to save to
     * @param checkpoint - Checkpoint data to persist
     * @returns Effect that completes when checkpoint has been saved
     */
    readonly saveCheckpoint: (
      store: StoreRef,
      checkpoint: IndexCheckpoint
    ) => Effect.Effect<void, StoreIndexError>;

    /**
     * Query posts with filtering and pagination
     *
     * Executes a query against the index with optional:
     * - Filter expressions (converted to SQL via pushdown)
     * - Date range constraints
     * - Scan limits (maximum posts to examine)
     * - Sort order (ascending/descending)
     *
     * Results are streamed using keyset pagination for efficient large result sets.
     *
     * @param store - Store reference to query
     * @param query - Query configuration including filter, range, limit, and order
     * @returns Stream of Posts matching the query criteria
     */
    readonly query: (
      store: StoreRef,
      query: StoreQuery
    ) => Stream.Stream<Post, StoreIndexError>;

    /**
     * Search posts using full-text search (FTS5)
     *
     * Performs a full-text search across post content using SQLite FTS5.
     * Supports different sort orders: relevance (BM25 ranking), newest, or oldest.
     * Results are paginated using offset-based cursors.
     *
     * @param store - Store reference to search
     * @param input - Search configuration
     * @param input.query - Search query string (FTS5 syntax supported)
     * @param input.limit - Maximum results to return (default: 25)
     * @param input.cursor - Offset for pagination (default: 0)
     * @param input.sort - Sort order: "relevance" | "newest" | "oldest"
     * @returns Effect containing search results and optional next cursor
     */
    readonly searchPosts: (
      store: StoreRef,
      input: {
        readonly query: string;
        readonly limit?: number;
        readonly cursor?: number;
        readonly sort?: SearchSort;
      }
    ) => Effect.Effect<{ readonly posts: ReadonlyArray<Post>; readonly cursor?: number }, StoreIndexError>;

    /**
     * Stream all index entries
     *
     * Returns a stream of PostIndexEntry objects containing basic metadata
     * (URI, creation date, author, hashtags) for all posts in the index.
     * Results are paginated internally and streamed as a continuous flow.
     *
     * @param store - Store reference to stream from
     * @returns Stream of PostIndexEntry objects
     */
    readonly entries: (store: StoreRef) => Stream.Stream<PostIndexEntry, StoreIndexError>;

    /**
     * Count total posts in the index
     *
     * Returns the total number of posts currently indexed in the store.
     *
     * @param store - Store reference to count
     * @returns Effect containing the post count
     */
    readonly count: (store: StoreRef) => Effect.Effect<number, StoreIndexError>;

    /**
     * Rebuild the index from the event log
     *
     * Performs a full or incremental rebuild of the index:
     * - If a checkpoint exists, only processes events after the checkpoint
     * - If no checkpoint exists, processes all events from the beginning
     * - Updates the checkpoint upon completion
     * - Runs ANALYZE and PRAGMA optimize for query performance
     *
     * Events are processed in batches within transactions for efficiency.
     *
     * @param store - Store reference to rebuild
     * @returns Effect that completes when rebuild is finished
     */
    readonly rebuild: (
      store: StoreRef
    ) => Effect.Effect<void, StoreIndexError>;
  }
>() {
  static readonly layer = Layer.scoped(
    StoreIndex,
    Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      const storeDb = yield* StoreDb;
      const bootstrapped = yield* Ref.make(new Set<string>());
      const withClient = <A, E>(
        store: StoreRef,
        message: string,
        run: (client: SqlClient.SqlClient) => Effect.Effect<A, E>
      ) =>
        storeDb
          .withClient(store, (client) =>
            Ref.modify(bootstrapped, (state) => {
              if (state.has(store.name)) {
                return [Effect.void, state] as const;
              }
              const next = new Set(state);
              next.add(store.name);
              return [bootstrapStore(store, client), next] as const;
            }).pipe(Effect.flatten, Effect.andThen(run(client)))
          )
          .pipe(Effect.mapError(toStoreIndexError(message)));

      const loadCheckpointWithClient = (client: SqlClient.SqlClient, index: string) => {
        const load = SqlSchema.findOne({
          Request: Schema.String,
          Result: checkpointRow,
          execute: (name) =>
            client`SELECT index_name, version, last_event_id, event_count, updated_at
              FROM index_checkpoints
              WHERE index_name = ${name}`
        });

        return load(index).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (row) => decodeCheckpointRow(row).pipe(Effect.map(Option.some))
            })
          )
        );
      };

      const saveCheckpointWithClient = (client: SqlClient.SqlClient, checkpoint: IndexCheckpoint) => {
        const updatedAt = toIso(checkpoint.updatedAt);
        return client`INSERT INTO index_checkpoints (index_name, version, last_event_id, event_count, updated_at)
          VALUES (${checkpoint.index}, ${checkpoint.version}, ${checkpoint.lastEventId}, ${checkpoint.eventCount}, ${updatedAt})
          ON CONFLICT(index_name) DO UPDATE SET
            version = excluded.version,
            last_event_id = excluded.last_event_id,
            event_count = excluded.event_count,
            updated_at = excluded.updated_at`.pipe(Effect.asVoid);
      };

      const applyWithClient = (client: SqlClient.SqlClient, record: PostEventRecord) =>
        Effect.gen(function* () {
          if (record.event._tag === "PostUpsert") {
            yield* applyUpsert(client, record.event);
            return;
          }
          if (record.event._tag === "PostDelete") {
            yield* applyDelete(client, record.event);
          }
        });

      const rebuildWithClient = (store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const checkpoint = yield* loadCheckpointWithClient(client, indexName);
          const lastEventId = Option.map(checkpoint, (value) => value.lastEventId);

          const stream = eventLog.stream(store).pipe(
            Stream.filter((record) =>
              Option.match(lastEventId, {
                onNone: () => true,
                onSome: (id) => record.id.localeCompare(id) > 0
              })
            )
          );

          const state = yield* stream.pipe(
            Stream.grouped(entryPageSize),
            Stream.runFoldEffect(
              {
                count: 0,
                lastId: Option.none<PostEventRecord["id"]>()
              },
              (state, batch) =>
                client.withTransaction(
                  Effect.gen(function* () {
                    for (const record of batch) {
                      yield* applyWithClient(client, record);
                    }
                    const size = Chunk.size(batch);
                    const lastRecord = size > 0 ? Option.some(Chunk.unsafeLast(batch).id) : state.lastId;
                    return {
                      count: state.count + size,
                      lastId: lastRecord
                    };
                  })
                )
            )
          );

          if (state.count === 0 || Option.isNone(state.lastId)) {
            return;
          }

          const updatedAt = yield* Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())
            )
          );
          const nextCheckpoint = IndexCheckpoint.make({
            index: indexName,
            version: 1,
            lastEventId: state.lastId.value,
            eventCount: Option.match(checkpoint, {
              onNone: () => state.count,
              onSome: (value) => value.eventCount + state.count
            }),
            updatedAt
          });

          yield* saveCheckpointWithClient(client, nextCheckpoint);
          yield* client`ANALYZE`;
          yield* client`PRAGMA optimize`;
        });

      const bootstrapStore = (store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const countRows = yield* client`SELECT COUNT(*) as count FROM posts`;
          const count = Number(countRows[0]?.count ?? 0);
          if (count > 0) {
            return;
          }

          const lastEventId = yield* eventLog.getLastEventId(store);
          if (Option.isNone(lastEventId)) {
            return;
          }

          yield* rebuildWithClient(store, client);
        });

      const apply = Effect.fn("StoreIndex.apply")(
        (store: StoreRef, record: PostEventRecord) =>
          withClient(store, "StoreIndex.apply failed", (client) =>
            client.withTransaction(applyWithClient(client, record))
          )
      );

      const getByDate = Effect.fn("StoreIndex.getByDate")(
        (store: StoreRef, date: string) =>
          withClient(store, "StoreIndex.getByDate failed", (client) => {
            const find = SqlSchema.findAll({
              Request: Schema.String,
              Result: postUriRow,
              execute: (value) =>
                client`SELECT uri FROM posts WHERE created_date = ${value} ORDER BY created_at ASC`
            });

            return find(date).pipe(
              Effect.map((rows) => rows.map((row) => row.uri))
            );
          })
      );

      const getByHashtag = Effect.fn("StoreIndex.getByHashtag")(
        (store: StoreRef, tag: string) =>
          withClient(store, "StoreIndex.getByHashtag failed", (client) => {
            const find = SqlSchema.findAll({
              Request: Schema.String,
              Result: postUriRow,
              execute: (value) =>
                client`SELECT uri FROM post_hashtag WHERE tag = ${value} ORDER BY uri ASC`
            });

            return find(tag).pipe(
              Effect.map((rows) => rows.map((row) => row.uri))
            );
          })
      );

      const getPost = Effect.fn("StoreIndex.getPost")(
        (store: StoreRef, uri: PostUri) =>
          withClient(store, "StoreIndex.getPost failed", (client) => {
            const find = SqlSchema.findOne({
              Request: PostUri,
              Result: postJsonRow,
              execute: (value) =>
                client`SELECT post_json FROM posts WHERE uri = ${value}`
            });

            return find(uri).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (row) =>
                    decodePostJson(row.post_json).pipe(Effect.map(Option.some))
                })
              )
            );
          })
      );

      const hasUri = Effect.fn("StoreIndex.hasUri")((store: StoreRef, uri: PostUri) =>
        withClient(store, "StoreIndex.hasUri failed", (client) =>
          client`SELECT 1 FROM posts WHERE uri = ${uri} LIMIT 1`.pipe(
            Effect.map((rows) => rows.length > 0)
          )
        )
      );

      const clear = Effect.fn("StoreIndex.clear")((store: StoreRef) =>
        withClient(store, "StoreIndex.clear failed", (client) =>
          client.withTransaction(
            Effect.gen(function* () {
              yield* client`DELETE FROM post_hashtag`;
              yield* client`DELETE FROM post_lang`;
              yield* client`DELETE FROM posts`;
              yield* client`DELETE FROM index_checkpoints`;
            })
          )
        )
      );

      const loadCheckpoint = Effect.fn("StoreIndex.loadCheckpoint")(
        (store: StoreRef, index: string) =>
          withClient(store, "StoreIndex.loadCheckpoint failed", (client) =>
            loadCheckpointWithClient(client, index)
          )
      );

      const saveCheckpoint = Effect.fn("StoreIndex.saveCheckpoint")(
        (store: StoreRef, checkpoint: IndexCheckpoint) =>
          withClient(store, "StoreIndex.saveCheckpoint failed", (client) =>
            saveCheckpointWithClient(client, checkpoint)
          )
      );

      const query = (store: StoreRef, q: StoreQuery) => {
        const start = q.range ? toIso(q.range.start) : undefined;
        const end = q.range ? toIso(q.range.end) : undefined;
        const scanLimit = q.scanLimit;
        const order = q.order === "desc" ? "DESC" : "ASC";
        const pushdownExpr = buildPushdown(q.filter);

        const initialState: QueryCursorState = {
          lastCreatedAt: undefined,
          lastUri: undefined,
          fetched: 0
        };

        return Stream.paginateChunkEffect(
          initialState,
          ({ lastCreatedAt, lastUri, fetched }) =>
            withClient(store, "StoreIndex.query failed", (client) =>
              Effect.gen(function* () {
                if (scanLimit !== undefined && fetched >= scanLimit) {
                  return [Chunk.empty<Post>(), Option.none<QueryCursorState>()] as const;
                }
                const pageSize =
                  scanLimit !== undefined
                    ? Math.min(entryPageSize, scanLimit - fetched)
                    : entryPageSize;

                const rangeClause =
                  start && end
                    ? client`p.created_at >= ${start} AND p.created_at <= ${end}`
                    : undefined;
                const keysetClause =
                  lastCreatedAt && lastUri
                    ? order === "ASC"
                      ? client`(p.created_at > ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri > ${lastUri}))`
                      : client`(p.created_at < ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri < ${lastUri}))`
                    : undefined;
                const pushdownClause = pushdownToSql(client, pushdownExpr);
                const whereParts = [
                  ...(rangeClause ? [rangeClause] : []),
                  ...(keysetClause ? [keysetClause] : []),
                  ...(pushdownClause ? [pushdownClause] : [])
                ];
                const where = client.and(whereParts);

                const rows = yield* client`SELECT post_json FROM posts p
                      WHERE ${where}
                      ORDER BY p.created_at ${client.unsafe(order)}, p.uri ${client.unsafe(order)}
                      LIMIT ${pageSize}`;

                const decoded = yield* Schema.decodeUnknown(
                  Schema.Array(postJsonRow)
                )(rows).pipe(
                  Effect.mapError(toStoreIndexError("StoreIndex.query decode failed"))
                );

                const posts = yield* Effect.forEach(
                  decoded,
                  (row) => decodePostJson(row.post_json),
                  { discard: false }
                );

                const newFetched = fetched + posts.length;
                const done =
                  posts.length < pageSize ||
                  (scanLimit !== undefined && newFetched >= scanLimit);
                const lastPost = posts.length > 0 ? posts[posts.length - 1] : undefined;
                const nextCreatedAt = lastPost ? toIso(lastPost.createdAt) : lastCreatedAt;
                const nextUri = lastPost ? lastPost.uri : lastUri;

                const next = done
                  ? Option.none<QueryCursorState>()
                  : Option.some({ lastCreatedAt: nextCreatedAt, lastUri: nextUri, fetched: newFetched });

                return [Chunk.fromIterable(posts), next] as const;
              })
            )
        );
      };

      const searchPosts = Effect.fn("StoreIndex.searchPosts")(
        (store: StoreRef, input: { readonly query: string; readonly limit?: number; readonly cursor?: number; readonly sort?: SearchSort }) =>
          withClient(store, "StoreIndex.searchPosts failed", (client) =>
            Effect.gen(function* () {
              const query = input.query.trim();
              if (query.length === 0) {
                return { posts: [] as ReadonlyArray<Post> };
              }
              const limit = input.limit && input.limit > 0 ? input.limit : 25;
              const offset = input.cursor && input.cursor > 0 ? input.cursor : 0;
              const sort = input.sort ?? "relevance";
              const orderBy =
                sort === "relevance"
                  ? "bm25(posts_fts)"
                  : sort === "oldest"
                    ? "p.created_at ASC, p.uri ASC"
                    : "p.created_at DESC, p.uri DESC";

              const rows = yield* client`SELECT p.post_json FROM posts_fts
                JOIN posts p ON p.rowid = posts_fts.rowid
                WHERE posts_fts MATCH ${query}
                ORDER BY ${client.unsafe(orderBy)}
                LIMIT ${limit} OFFSET ${offset}`;

              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(postJsonRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.searchPosts decode failed"))
              );

              const posts = yield* Effect.forEach(
                decoded,
                (row) => decodePostJson(row.post_json),
                { discard: false }
              );

              const nextCursor = posts.length < limit ? undefined : offset + posts.length;

              return nextCursor !== undefined
                ? { posts, cursor: nextCursor }
                : { posts };
            })
          )
      );

      const entries = (store: StoreRef) =>
        Stream.paginateChunkEffect(0, (offset) =>
          withClient(store, "StoreIndex.entries failed", (client) =>
            Effect.gen(function* () {
              const rows = yield* client`SELECT
                  p.uri as uri,
                  p.created_date as created_date,
                  p.author as author,
                  group_concat(h.tag) as hashtags
                FROM posts p
                LEFT JOIN post_hashtag h ON p.uri = h.uri
                GROUP BY p.uri
                ORDER BY p.created_at ASC
                LIMIT ${entryPageSize} OFFSET ${offset}`;

              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(postEntryRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.entries decode failed"))
              );

              const entries = yield* Effect.forEach(
                decoded,
                (row) => decodeEntryRow(row),
                { discard: false }
              );

              const next =
                entries.length < entryPageSize
                  ? Option.none<number>()
                  : Option.some(offset + entryPageSize);

              return [Chunk.fromIterable(entries), next] as const;
            })
          )
        );

      const count = Effect.fn("StoreIndex.count")((store: StoreRef) =>
        withClient(store, "StoreIndex.count failed", (client) =>
          client`SELECT COUNT(*) as count FROM posts`.pipe(
            Effect.map((rows) => Number(rows[0]?.count ?? 0))
          )
        )
      );

      const rebuild = Effect.fn("StoreIndex.rebuild")((store: StoreRef) =>
        withClient(store, "StoreIndex.rebuild failed", (client) =>
          rebuildWithClient(store, client)
        )
      );

      return StoreIndex.of({
        apply,
        getByDate,
        getByHashtag,
        getPost,
        hasUri,
        clear,
        loadCheckpoint,
        saveCheckpoint,
        query,
        searchPosts,
        entries,
        count,
        rebuild
      });
    })
  );
}

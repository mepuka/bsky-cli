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
 * - **Media filters**: HasLinks, HasMedia, HasEmbed, HasImages, MinImages, HasAltText, NoAltText, AltText, HasVideo
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

import { Chunk, Clock, Effect, Match, Option, Predicate, Ref, Schema, Stream } from "effect";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import type { Fragment } from "@effect/sql/Statement";
import { StoreIndexError } from "../domain/errors.js";
import { PostEventRecord, isPostDelete, isPostUpsert } from "../domain/events.js";
import type { PostEvent, StoreQuery } from "../domain/events.js";
import type { FilterExpr } from "../domain/filter.js";
import { IndexCheckpoint, PostIndexEntry } from "../domain/indexes.js";
import { EventSeq, Handle, PostUri, Timestamp } from "../domain/primitives.js";
import { Post } from "../domain/post.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";
import { deletePost, upsertPost } from "./store-index-sql.js";

const indexName = "primary";
const entryPageSize = 500;

type SearchSort = "relevance" | "newest" | "oldest";
type QueryCursorState = {
  readonly lastCreatedAt: string | undefined;
  readonly lastUri: string | undefined;
  readonly lastMetric: number | undefined;
  readonly fetched: number;
};

export type ThreadGroup = {
  readonly rootUri: PostUri;
  readonly count: number;
  readonly firstCreatedAt: string;
};

const postUriRow = Schema.Struct({ uri: PostUri });
const postJsonRow = Schema.Struct({ post_json: Schema.String });
const threadRootRow = Schema.Struct({ root_uri: PostUri });
const postMetricRow = Schema.Struct({
  post_json: Schema.String,
  like_count: Schema.Number,
  repost_count: Schema.Number,
  reply_count: Schema.Number,
  quote_count: Schema.Number
});
const threadGroupRow = Schema.Struct({
  root_uri: PostUri,
  count: Schema.Number,
  first_created_at: Schema.String
});
const postEntryRow = Schema.Struct({
  uri: PostUri,
  created_date: Schema.String,
  author: Schema.NullOr(Handle),
  hashtags: Schema.NullOr(Schema.String)
});
const postEntryPageRow = Schema.Struct({
  uri: PostUri,
  created_at: Schema.String,
  created_date: Schema.String,
  author: Schema.NullOr(Handle),
  hashtags: Schema.NullOr(Schema.String)
});
const checkpointRow = Schema.Struct({
  index_name: Schema.String,
  version: Schema.Number,
  last_event_seq: EventSeq,
  event_count: Schema.Number,
  updated_at: Schema.String
});
const eventLogRow = Schema.Struct({
  event_seq: EventSeq,
  payload_json: Schema.String
});
const lastEventSeqRow = Schema.Struct({
  value: EventSeq
});

const toStoreIndexError = (message: string) => (cause: unknown) =>
  cause instanceof StoreIndexError
    ? cause
    : StoreIndexError.make({ message, cause });

const decodePostJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(Post))(raw).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.post decode failed"))
  );

const ftsOperatorPattern = /\b(AND|OR|NOT|NEAR)\b/i;
const ftsSyntaxPattern = /["*():^]/;

const hasFtsSyntax = (query: string) =>
  ftsOperatorPattern.test(query) || ftsSyntaxPattern.test(query);

const buildLiteralFtsQuery = (query: string) => {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens
    .map((token) => `"${token.replaceAll("\"", "\"\"")}"`)
    .join(" AND ");
};

const buildColumnLiteralFtsQuery = (column: string, query: string) => {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return "";
  }
  return tokens
    .map((token) => `${column}:"${token.replaceAll("\"", "\"\"")}"`)
    .join(" AND ");
};

const buildColumnFtsQuery = (column: string, query: string) => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return buildColumnLiteralFtsQuery(column, trimmed);
};

const decodeEntryRow = (row: typeof postEntryRow.Type | typeof postEntryPageRow.Type) =>
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
    lastEventSeq: row.last_event_seq,
    eventCount: row.event_count,
    updatedAt: row.updated_at
  }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.checkpoint decode failed")));

const decodeEventRow = (row: typeof eventLogRow.Type) =>
  Schema.decodeUnknown(Schema.parseJson(PostEventRecord))(row.payload_json).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.event decode failed")),
    Effect.map((record) => ({ seq: row.event_seq, record } as const))
  );

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
  /** Filter for posts with any embed */
  | { readonly _tag: "HasEmbed" }
  /** Filter for posts with images */
  | { readonly _tag: "HasImages" }
  /** Filter for posts with at least N images */
  | { readonly _tag: "MinImages"; readonly min: number }
  /** Filter for posts where all images have alt text */
  | { readonly _tag: "HasAltText" }
  /** Filter for posts with images missing alt text */
  | { readonly _tag: "NoAltText" }
  /** Filter for posts with alt text matching a substring */
  | { readonly _tag: "AltText"; readonly text: string }
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
    if (Predicate.isTagged(clause, "False")) {
      return pushdownFalse;
    }
    if (Predicate.isTagged(clause, "True")) {
      continue;
    }
    if (Predicate.isTagged(clause, "And")) {
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
    if (Predicate.isTagged(clause, "True")) {
      return pushdownTrue;
    }
    if (Predicate.isTagged(clause, "False")) {
      continue;
    }
    if (Predicate.isTagged(clause, "Or")) {
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
  return Match.type<FilterExpr>().pipe(
    Match.withReturnType<PushdownExpr>(),
    Match.tagsExhaustive({
      All: () => pushdownTrue,
      None: () => pushdownFalse,
      And: (andExpr) =>
        simplifyAnd([buildPushdown(andExpr.left), buildPushdown(andExpr.right)]),
      Or: (orExpr) =>
        simplifyOr([buildPushdown(orExpr.left), buildPushdown(orExpr.right)]),
      Not: () => pushdownTrue,
      Author: (author) => ({ _tag: "Author", handle: author.handle }),
      Hashtag: (hashtag) => ({ _tag: "Hashtag", tag: hashtag.tag }),
      AuthorIn: (authorIn) =>
        authorIn.handles.length === 0
          ? pushdownFalse
          : { _tag: "AuthorIn", handles: Array.from(new Set(authorIn.handles)) },
      HashtagIn: (hashtagIn) =>
        hashtagIn.tags.length === 0
          ? pushdownFalse
          : { _tag: "HashtagIn", tags: Array.from(new Set(hashtagIn.tags)) },
      Contains: (contains) => ({
        _tag: "Contains",
        text: contains.text,
        caseSensitive: contains.caseSensitive ?? false
      }),
      IsReply: () => ({ _tag: "IsReply" }),
      IsQuote: () => ({ _tag: "IsQuote" }),
      IsRepost: () => ({ _tag: "IsRepost" }),
      IsOriginal: () => ({ _tag: "IsOriginal" }),
      Engagement: (engagement) => ({
        _tag: "Engagement",
        ...(engagement.minLikes !== undefined ? { minLikes: engagement.minLikes } : {}),
        ...(engagement.minReposts !== undefined ? { minReposts: engagement.minReposts } : {}),
        ...(engagement.minReplies !== undefined ? { minReplies: engagement.minReplies } : {})
      }),
      HasImages: () => ({ _tag: "HasImages" }),
      MinImages: (minImages) => ({ _tag: "MinImages", min: minImages.min }),
      HasAltText: () => ({ _tag: "HasAltText" }),
      NoAltText: () => ({ _tag: "NoAltText" }),
      AltText: (altText) => ({ _tag: "AltText", text: altText.text }),
      AltTextRegex: () => pushdownTrue,
      HasVideo: () => ({ _tag: "HasVideo" }),
      HasLinks: () => ({ _tag: "HasLinks" }),
      LinkContains: () => pushdownTrue,
      LinkRegex: () => pushdownTrue,
      HasMedia: () => ({ _tag: "HasMedia" }),
      HasEmbed: () => ({ _tag: "HasEmbed" }),
      Language: (language) => {
        if (language.langs.length === 0) {
          return pushdownFalse;
        }
        const langs = normalizeLangs(language.langs);
        return langs.length === 0 ? pushdownFalse : { _tag: "Language", langs };
      },
      Regex: () => pushdownTrue,
      DateRange: (dateRange) => ({
        _tag: "DateRange",
        start: dateRange.start,
        end: dateRange.end
      }),
      HasValidLinks: () => pushdownTrue,
      Trending: () => pushdownTrue
    })
  )(expr);
};

const isAscii = (value: string) => /^[\x00-\x7F]*$/.test(value);

const normalizeLangs = (langs: ReadonlyArray<string>) =>
  Array.from(
    new Set(
      langs.map((lang) => lang.trim().toLowerCase()).filter((lang) => lang.length > 0)
    )
  );

const asFragment = (fragment: Fragment): Fragment => fragment;

const pushdownToSql = (
  sql: SqlClient.SqlClient,
  expr: PushdownExpr
): Fragment | undefined => {
  return Match.type<PushdownExpr>().pipe(
    Match.withReturnType<Fragment | undefined>(),
    Match.tagsExhaustive({
      True: () => undefined,
      False: () => asFragment(sql`1=0`),
      Author: (author) => asFragment(sql`p.author = ${author.handle}`),
      AuthorIn: (authorIn) =>
        authorIn.handles.length === 0
          ? asFragment(sql`1=0`)
          : asFragment(sql`p.author IN ${sql.in(authorIn.handles)}`),
      Hashtag: (hashtag) =>
        asFragment(
          sql`EXISTS (SELECT 1 FROM post_hashtag h WHERE h.uri = p.uri AND h.tag = ${hashtag.tag})`
        ),
      HashtagIn: (hashtagIn) =>
        hashtagIn.tags.length === 0
          ? asFragment(sql`1=0`)
          : asFragment(
              sql`EXISTS (SELECT 1 FROM post_hashtag h WHERE h.uri = p.uri AND h.tag IN ${sql.in(hashtagIn.tags)})`
            ),
      DateRange: (dateRange) => {
        const start = toIso(dateRange.start);
        const end = toIso(dateRange.end);
        return asFragment(sql`p.created_at >= ${start} AND p.created_at <= ${end}`);
      },
      IsReply: () => asFragment(sql`p.is_reply = 1`),
      IsQuote: () => asFragment(sql`p.is_quote = 1`),
      IsRepost: () => asFragment(sql`p.is_repost = 1`),
      IsOriginal: () => asFragment(sql`p.is_original = 1`),
      HasLinks: () => asFragment(sql`p.has_links = 1`),
      HasMedia: () => asFragment(sql`p.has_media = 1`),
      HasEmbed: () => asFragment(sql`p.has_embed = 1`),
      HasImages: () => asFragment(sql`p.has_images = 1`),
      MinImages: (minImages) => asFragment(sql`p.image_count >= ${minImages.min}`),
      HasAltText: () => asFragment(sql`p.has_alt_text = 1`),
      NoAltText: () => asFragment(sql`p.image_count > 0 AND p.has_alt_text = 0`),
      AltText: (altText) => {
        const text = altText.text;
        if (text.length === 0) {
          return undefined;
        }
        if (!isAscii(text)) {
          return undefined;
        }
        const ftsQuery = buildColumnFtsQuery("alt_text", text);
        if (ftsQuery.length === 0) {
          return undefined;
        }
        return asFragment(
          sql`EXISTS (SELECT 1 FROM posts_fts
            WHERE posts_fts.rowid = p.rowid
              AND posts_fts MATCH ${ftsQuery})`
        );
      },
      HasVideo: () => asFragment(sql`p.has_video = 1`),
      Language: (language) =>
        language.langs.length === 0
          ? asFragment(sql`1=0`)
          : asFragment(
              sql`(
                EXISTS (
                  SELECT 1 FROM post_lang l
                  WHERE l.uri = p.uri AND l.lang IN ${sql.in(language.langs)}
                )
                OR (
                  p.lang IS NOT NULL
                  AND lower(p.lang) IN ${sql.in(language.langs)}
                )
              )`
            ),
      Engagement: (engagement) => {
        const clauses: Array<Fragment> = [];
        if (engagement.minLikes !== undefined) {
          clauses.push(asFragment(sql`p.like_count >= ${engagement.minLikes}`));
        }
        if (engagement.minReposts !== undefined) {
          clauses.push(asFragment(sql`p.repost_count >= ${engagement.minReposts}`));
        }
        if (engagement.minReplies !== undefined) {
          clauses.push(asFragment(sql`p.reply_count >= ${engagement.minReplies}`));
        }
        if (clauses.length === 0) {
          return undefined;
        }
        return sql.and(clauses);
      },
      Contains: (contains) => {
        const text = contains.text;
        if (text.length === 0) {
          return undefined;
        }
        if (contains.caseSensitive) {
          return asFragment(sql`instr(p.text, ${text}) > 0`);
        }
        if (!isAscii(text)) {
          return undefined;
        }
        return asFragment(sql`instr(lower(p.text), lower(${text})) > 0`);
      },
      And: (andExpr) => {
        const clauses = andExpr.clauses
          .map((clause) => pushdownToSql(sql, clause))
          .filter((clause): clause is Fragment => clause !== undefined);
        if (clauses.length === 0) {
          return undefined;
        }
        return sql.and(clauses);
      },
      Or: (orExpr) => {
        const clauses: Array<Fragment> = [];
        for (const clause of orExpr.clauses) {
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
    })
  )(expr);
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
export class StoreIndex extends Effect.Service<StoreIndex>()("@skygent/StoreIndex", {
  scoped: Effect.gen(function* () {
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
            client`SELECT index_name, version, last_event_seq, event_count, updated_at
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
        return client`INSERT INTO index_checkpoints (index_name, version, last_event_seq, event_count, updated_at)
          VALUES (${checkpoint.index}, ${checkpoint.version}, ${checkpoint.lastEventSeq}, ${checkpoint.eventCount}, ${updatedAt})
          ON CONFLICT(index_name) DO UPDATE SET
            version = excluded.version,
            last_event_seq = excluded.last_event_seq,
            event_count = excluded.event_count,
            updated_at = excluded.updated_at`.pipe(Effect.asVoid);
      };

      const applyWithClient = (client: SqlClient.SqlClient, record: PostEventRecord) =>
        Effect.gen(function* () {
          if (isPostUpsert(record.event)) {
            yield* applyUpsert(client, record.event);
            return;
          }
          if (isPostDelete(record.event)) {
            yield* applyDelete(client, record.event);
          }
        });

      const rebuildWithClient = (_store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const checkpoint = yield* loadCheckpointWithClient(client, indexName);
          const initialCursor = Option.map(checkpoint, (value) => value.lastEventSeq);

          const loadBatch = (cursor: Option.Option<EventSeq>) =>
            Option.match(cursor, {
              onNone: () =>
                client`SELECT event_seq, payload_json
                  FROM event_log
                  ORDER BY event_seq ASC
                  LIMIT ${entryPageSize}`,
              onSome: (seq) =>
                client`SELECT event_seq, payload_json
                  FROM event_log
                  WHERE event_seq > ${seq}
                  ORDER BY event_seq ASC
                  LIMIT ${entryPageSize}`
            }).pipe(
              Effect.flatMap((rows) => Schema.decodeUnknown(Schema.Array(eventLogRow))(rows)),
              Effect.flatMap((rows) =>
                Effect.forEach(rows, decodeEventRow, { discard: false })
              ),
              Effect.mapError(toStoreIndexError("StoreIndex.rebuild event load failed"))
            );

          let count = 0;
          let lastSeq = initialCursor;
          let cursor = initialCursor;

          while (true) {
            const batch = yield* loadBatch(cursor);
            if (batch.length === 0) {
              break;
            }

            yield* client.withTransaction(
              Effect.forEach(batch, (entry) => applyWithClient(client, entry.record), {
                discard: true
              })
            );

            const tail = batch[batch.length - 1]!.seq;
            cursor = Option.some(tail);
            lastSeq = Option.some(tail);
            count += batch.length;
          }

          const state = { count, lastSeq };

          if (state.count === 0 || Option.isNone(state.lastSeq)) {
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
            lastEventSeq: state.lastSeq.value,
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

      const bootstrapStore = (_store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const countRows = yield* client`SELECT COUNT(*) as count FROM posts`;
          const count = Number(countRows[0]?.count ?? 0);
          if (count > 0) {
            return;
          }

          const lastRows = yield* client`SELECT event_seq as value
            FROM event_log
            ORDER BY event_seq DESC
            LIMIT 1`.pipe(
            Effect.flatMap((rows) => Schema.decodeUnknown(Schema.Array(lastEventSeqRow))(rows)),
            Effect.mapError(toStoreIndexError("StoreIndex.bootstrap last event decode failed"))
          );
          const lastEventSeq =
            lastRows.length > 0
              ? Option.some(lastRows[0]!.value)
              : Option.none<EventSeq>();
          if (Option.isNone(lastEventSeq)) {
            return;
          }

          yield* rebuildWithClient(_store, client);
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

      const getByAuthor = Effect.fn("StoreIndex.getByAuthor")(
        (store: StoreRef, author: Handle) =>
          withClient(store, "StoreIndex.getByAuthor failed", (client) => {
            const find = SqlSchema.findAll({
              Request: Handle,
              Result: postUriRow,
              execute: (value) =>
                client`SELECT uri FROM posts WHERE author = ${value} ORDER BY created_at ASC`
            });

            return find(author).pipe(
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
        const sortBy = q.sortBy ?? "createdAt";
        const order = q.order === "desc" ? "DESC" : "ASC";
        const pushdownExpr = buildPushdown(q.filter);

        const initialState: QueryCursorState = {
          lastCreatedAt: undefined,
          lastUri: undefined,
          lastMetric: undefined,
          fetched: 0
        };

        return Stream.paginateChunkEffect(
          initialState,
          ({ lastCreatedAt, lastUri, lastMetric, fetched }) =>
            withClient(store, "StoreIndex.query failed", (client) =>
              Effect.gen(function* () {
                if (scanLimit !== undefined && fetched >= scanLimit) {
                  return [Chunk.empty<Post>(), Option.none<QueryCursorState>()] as const;
                }
                const pageSize =
                  scanLimit !== undefined
                    ? Math.min(entryPageSize, scanLimit - fetched)
                    : entryPageSize;

                const metricExpr =
                  sortBy === "likeCount"
                    ? client`p.like_count`
                    : sortBy === "repostCount"
                      ? client`p.repost_count`
                      : sortBy === "replyCount"
                        ? client`p.reply_count`
                        : sortBy === "quoteCount"
                          ? client`p.quote_count`
                          : sortBy === "engagement"
                            ? client`(p.like_count + (p.repost_count * 2) + (p.reply_count * 3) + (p.quote_count * 2))`
                            : undefined;

                const rangeClause =
                  start && end
                    ? client`p.created_at >= ${start} AND p.created_at <= ${end}`
                    : undefined;
                const keysetClause =
                  sortBy === "createdAt"
                    ? lastCreatedAt && lastUri
                      ? order === "ASC"
                        ? client`(p.created_at > ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri > ${lastUri}))`
                        : client`(p.created_at < ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri < ${lastUri}))`
                      : undefined
                    : metricExpr && lastMetric !== undefined && lastCreatedAt && lastUri
                      ? order === "ASC"
                        ? client`(${metricExpr} > ${lastMetric} OR (${metricExpr} = ${lastMetric} AND (p.created_at > ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri > ${lastUri}))))`
                        : client`(${metricExpr} < ${lastMetric} OR (${metricExpr} = ${lastMetric} AND (p.created_at < ${lastCreatedAt} OR (p.created_at = ${lastCreatedAt} AND p.uri < ${lastUri}))))`
                      : undefined;
                const pushdownClause = pushdownToSql(client, pushdownExpr);
                const whereParts = [
                  ...(rangeClause ? [rangeClause] : []),
                  ...(keysetClause ? [keysetClause] : []),
                  ...(pushdownClause ? [pushdownClause] : [])
                ];
                const where = client.and(whereParts);

                const selectColumns =
                  sortBy === "createdAt"
                    ? client.unsafe("post_json")
                    : client.unsafe("post_json, like_count, repost_count, reply_count, quote_count");

                const orderBy =
                  sortBy === "createdAt" || !metricExpr
                    ? client`p.created_at ${client.unsafe(order)}, p.uri ${client.unsafe(order)}`
                    : client`${metricExpr} ${client.unsafe(order)}, p.created_at ${client.unsafe(order)}, p.uri ${client.unsafe(order)}`;

                const rows = yield* client`SELECT ${selectColumns} FROM posts p
                      WHERE ${where}
                      ORDER BY ${orderBy}
                      LIMIT ${pageSize}`;

                const decodedRows =
                  sortBy === "createdAt"
                    ? yield* Schema.decodeUnknown(Schema.Array(postJsonRow))(rows).pipe(
                        Effect.mapError(toStoreIndexError("StoreIndex.query decode failed"))
                      )
                    : yield* Schema.decodeUnknown(Schema.Array(postMetricRow))(rows).pipe(
                        Effect.mapError(toStoreIndexError("StoreIndex.query decode failed"))
                      );

                const posts = yield* Effect.forEach(
                  decodedRows,
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
                const metricRows =
                  sortBy === "createdAt"
                    ? undefined
                    : (decodedRows as ReadonlyArray<{
                        readonly post_json: string;
                        readonly like_count: number;
                        readonly repost_count: number;
                        readonly reply_count: number;
                        readonly quote_count: number;
                      }>);

                const nextMetric =
                  sortBy === "createdAt" || !metricRows
                    ? lastMetric
                    : posts.length > 0
                      ? (() => {
                          const lastRow = metricRows[metricRows.length - 1];
                          if (!lastRow) {
                            return lastMetric;
                          }
                          switch (sortBy) {
                            case "likeCount":
                              return lastRow.like_count;
                            case "repostCount":
                              return lastRow.repost_count;
                            case "replyCount":
                              return lastRow.reply_count;
                            case "quoteCount":
                              return lastRow.quote_count;
                            case "engagement":
                              return lastRow.like_count + (lastRow.repost_count * 2) + (lastRow.reply_count * 3) + (lastRow.quote_count * 2);
                            default:
                              return lastMetric;
                          }
                        })()
                      : lastMetric;

                const next = done
                  ? Option.none<QueryCursorState>()
                  : Option.some({ lastCreatedAt: nextCreatedAt, lastUri: nextUri, lastMetric: nextMetric, fetched: newFetched });

                return [Chunk.fromIterable(posts), next] as const;
              })
            )
        );
      };

      const threadPosts = Effect.fn("StoreIndex.threadPosts")(
        (store: StoreRef, uri: PostUri) =>
          withClient(store, "StoreIndex.threadPosts failed", (client) =>
            Effect.gen(function* () {
              const rootRows = yield* client`SELECT COALESCE(reply_root_uri, uri) as root_uri
                FROM posts
                WHERE uri = ${uri}
                LIMIT 1`;

              if (rootRows.length === 0) {
                return [] as ReadonlyArray<Post>;
              }

              const decodedRoot = yield* Schema.decodeUnknown(threadRootRow)(rootRows[0]).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.threadPosts root decode failed"))
              );
              const rootUri = decodedRoot.root_uri;

              const rows = yield* client`SELECT post_json FROM posts
                WHERE uri = ${rootUri} OR reply_root_uri = ${rootUri}
                ORDER BY created_at ASC`;

              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(postJsonRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.threadPosts decode failed"))
              );

              return yield* Effect.forEach(
                decoded,
                (row) => decodePostJson(row.post_json),
                { discard: false }
              );
            })
          )
      );

      const searchPosts = Effect.fn("StoreIndex.searchPosts")(
        (store: StoreRef, input: { readonly query: string; readonly limit?: number; readonly cursor?: number; readonly sort?: SearchSort }) =>
          withClient(store, "StoreIndex.searchPosts failed", (client) =>
            Effect.gen(function* () {
              const rawQuery = input.query.trim();
              if (rawQuery.length === 0) {
                return { posts: [] as ReadonlyArray<Post> };
              }
              const literalQuery = buildLiteralFtsQuery(rawQuery);
              const useRaw = hasFtsSyntax(rawQuery);
              const query = useRaw ? rawQuery : literalQuery;
              const limit = input.limit && input.limit > 0 ? input.limit : 25;
              const offset = input.cursor && input.cursor > 0 ? input.cursor : 0;
              const sort = input.sort ?? "relevance";
              const orderBy =
                sort === "relevance"
                  ? "bm25(posts_fts)"
                  : sort === "oldest"
                    ? "p.created_at ASC, p.uri ASC"
                    : "p.created_at DESC, p.uri DESC";

              const runSearch = (ftsQuery: string) =>
                client`SELECT p.post_json FROM posts_fts
                  JOIN posts p ON p.rowid = posts_fts.rowid
                  WHERE posts_fts MATCH ${ftsQuery}
                  ORDER BY ${client.unsafe(orderBy)}
                  LIMIT ${limit} OFFSET ${offset}`;

              const rows = yield* runSearch(query).pipe(
                Effect.catchAll((error) =>
                  useRaw && literalQuery !== query
                    ? runSearch(literalQuery)
                    : Effect.fail(error)
                )
              );

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
        Stream.paginateChunkEffect(
          undefined as { readonly createdAt: string; readonly uri: PostUri } | undefined,
          (cursor) =>
            withClient(store, "StoreIndex.entries failed", (client) =>
              Effect.gen(function* () {
                const where =
                  cursor === undefined
                    ? client`1 = 1`
                    : client`(
                    p.created_at > ${cursor.createdAt}
                    OR (p.created_at = ${cursor.createdAt} AND p.uri > ${cursor.uri})
                  )`;
                const rows = yield* client`SELECT
                  p.uri as uri,
                  p.created_at as created_at,
                  p.created_date as created_date,
                  p.author as author,
                  group_concat(h.tag) as hashtags
                FROM posts p
                LEFT JOIN post_hashtag h ON p.uri = h.uri
                WHERE ${where}
                GROUP BY p.uri
                ORDER BY p.created_at ASC, p.uri ASC
                LIMIT ${entryPageSize}`;

                const decoded = yield* Schema.decodeUnknown(
                  Schema.Array(postEntryPageRow)
                )(rows).pipe(
                  Effect.mapError(toStoreIndexError("StoreIndex.entries decode failed"))
                );

                const entries = yield* Effect.forEach(
                  decoded,
                  (row) => decodeEntryRow(row),
                  { discard: false }
                );

                const nextCursor =
                  entries.length < entryPageSize
                    ? undefined
                    : {
                        createdAt: decoded[decoded.length - 1]!.created_at,
                        uri: decoded[decoded.length - 1]!.uri
                      };

                return [
                  Chunk.fromIterable(entries),
                  nextCursor === undefined ? Option.none() : Option.some(nextCursor)
                ] as const;
              })
            )
        );

      const threadGroups = Effect.fn("StoreIndex.threadGroups")(
        (store: StoreRef, q: StoreQuery) =>
          withClient(store, "StoreIndex.threadGroups failed", (client) =>
            Effect.gen(function* () {
              const start = q.range ? toIso(q.range.start) : undefined;
              const end = q.range ? toIso(q.range.end) : undefined;
              const pushdownExpr = buildPushdown(q.filter);
              const order = q.order === "desc" ? "DESC" : "ASC";

              const rangeClause =
                start && end
                  ? client`p.created_at >= ${start} AND p.created_at <= ${end}`
                  : undefined;
              const pushdownClause = pushdownToSql(client, pushdownExpr);
              const whereParts = [
                ...(rangeClause ? [rangeClause] : []),
                ...(pushdownClause ? [pushdownClause] : [])
              ];
              const where = client.and(whereParts);

              const rows = yield* client`SELECT
                  COALESCE(p.reply_root_uri, p.uri) as root_uri,
                  MIN(p.created_at) as first_created_at,
                  COUNT(*) as count
                FROM posts p
                WHERE ${where}
                GROUP BY root_uri
                ORDER BY first_created_at ${client.unsafe(order)}, root_uri ${client.unsafe(order)}`;

              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(threadGroupRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.threadGroups decode failed"))
              );

              return decoded.map((row) => ({
                rootUri: row.root_uri,
                count: row.count,
                firstCreatedAt: row.first_created_at
              }));
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

      return {
        apply,
        getByDate,
        getByHashtag,
        getByAuthor,
        getPost,
        hasUri,
        clear,
        loadCheckpoint,
        saveCheckpoint,
        query,
        threadPosts,
        searchPosts,
        entries,
        threadGroups,
        count,
        rebuild
      };
    })
}) {
  static readonly layer = StoreIndex.Default;
}

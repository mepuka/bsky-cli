/**
 * Store Statistics Service
 *
 * Calculates and reports statistics for data stores.
 * Provides detailed metrics including post counts, author counts, date ranges,
 * top hashtags/authors, and store status (source vs derived, stale vs current).
 *
 * This service is used by the `skygent store stats` command to display
 * information about stores to users. It aggregates data from multiple sources:
 * - SQLite database for post/author counts and top items
 * - Store lineage for derivation information
 * - Store index for counts
 * - Checkpoint store for sync status
 *
 * @module services/store-stats
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { StoreStats } from "./services/store-stats.js";
 * import { StoreRef } from "./domain/store.js";
 *
 * const program = Effect.gen(function* () {
 *   const stats = yield* StoreStats;
 *
 *   // Get detailed stats for a specific store
 *   const storeStats = yield* stats.stats(StoreRef.make({
 *     name: "my-store",
 *     root: "my-store"
 *   }));
 *   console.log(`Posts: ${storeStats.posts}, Authors: ${storeStats.authors}`);
 *
 *   // Get summary of all stores
 *   const summary = yield* stats.summary();
 *   console.log(`Total stores: ${summary.total}, Total posts: ${summary.totalPosts}`);
 * });
 * ```
 */

import { FileSystem, Path } from "@effect/platform";
import { directorySize } from "./shared.js";
import { Context, Effect, Layer, Option } from "effect";
import { AppConfigService } from "./app-config.js";
import { StoreManager } from "./store-manager.js";
import { StoreIndex } from "./store-index.js";
import { StoreDb } from "./store-db.js";
import { LineageStore } from "./lineage-store.js";
import { DerivationValidator } from "./derivation-validator.js";
import { StoreEventLog } from "./store-event-log.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { DataSource } from "../domain/sync.js";
import { StoreName, type StorePath } from "../domain/primitives.js";
import { StoreRef } from "../domain/store.js";
import type { StoreLineage } from "../domain/derivation.js";
import { StoreIoError, type StoreIndexError } from "../domain/errors.js";

/**
 * Detailed statistics for a single store.
 * Includes post counts, author counts, date ranges, top items, and status.
 */
type StoreStatsResult = {
  /** Store name */
  readonly store: string;
  /** Total number of posts in the store */
  readonly posts: number;
  /** Number of unique authors in the store */
  readonly authors: number;
  /** Date range of posts (first and last post dates) */
  readonly dateRange?: { readonly first: string; readonly last: string };
  /** Top hashtags in the store (up to TOP_LIMIT) */
  readonly hashtags: ReadonlyArray<string>;
  /** Top authors by post count (up to TOP_LIMIT) */
  readonly topAuthors: ReadonlyArray<string>;
  /** Whether this is a derived store (vs source store) */
  readonly derived: boolean;
  /** Store status: source (not derived), ready (derived and current), stale (derived and outdated), or unknown */
  readonly status: "source" | "ready" | "stale" | "unknown";
  /** Sync status for source stores: current, stale, unknown, or empty */
  readonly syncStatus?: "current" | "stale" | "unknown" | "empty";
  /** Total size of the store directory in bytes */
  readonly sizeBytes: number;
};

/**
 * Summary entry for a single store in the overall summary.
 */
type StoreSummaryEntry = {
  /** Store name */
  readonly name: string;
  /** Number of posts in the store */
  readonly posts: number;
  /** Store status */
  readonly status: "source" | "ready" | "stale" | "unknown";
  /** Source store name (for single-source derived stores) */
  readonly source?: string;
  /** Source store names (for multi-source derived stores) */
  readonly sources?: ReadonlyArray<string>;
};

/**
 * Summary statistics across all stores.
 */
type StoreSummaryResult = {
  /** Total number of stores */
  readonly total: number;
  /** Number of source stores */
  readonly sources: number;
  /** Number of derived stores */
  readonly derived: number;
  /** Total posts across all stores */
  readonly totalPosts: number;
  /** Total size of all stores in bytes */
  readonly totalSizeBytes: number;
  /** Human-readable total size (e.g., "1.5MB") */
  readonly totalSize: string;
  /** Individual store summaries */
  readonly stores: ReadonlyArray<StoreSummaryEntry>;
};

/** Number of top items (hashtags/authors) to include in stats */
const TOP_LIMIT = 5;

/**
 * Parses a count value from database results.
 * Handles null/undefined by returning 0.
 * @param value - The value to parse as a count
 * @returns The parsed number
 */
const parseCount = (value: unknown) =>
  typeof value === "number" ? value : Number(value ?? 0);

/**
 * Converts an unknown error to a StoreIoError.
 * Preserves existing StoreIoError instances.
 * @param path - Store path for the error context
 * @returns A function that converts causes to StoreIoError
 */
const toStoreIoError = (path: StorePath) => (cause: unknown) => {
  if (typeof cause === "object" && cause !== null) {
    const tagged = cause as { _tag?: string };
    if (tagged._tag === "StoreIoError") {
      return tagged as StoreIoError;
    }
  }
  return StoreIoError.make({ path, cause });
};

/**
 * Formats a byte count as a human-readable string.
 * Uses appropriate units (B, KB, MB, GB, TB) and rounds to reasonable precision.
 * @param bytes - Number of bytes to format
 * @returns Human-readable size string (e.g., "1.5MB", "1024B")
 * @example
 * ```ts
 * formatBytes(1024) // "1KB"
 * formatBytes(1536000) // "1.5MB"
 * ```
 */
const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
};

/**
 * Checks if a store is derived based on its lineage.
 * @param lineage - Optional store lineage information
 * @returns True if the store is derived from other stores
 */
const isDerived = (lineage: Option.Option<StoreLineage>) =>
  Option.isSome(lineage) && lineage.value.isDerived;

/**
 * Extracts source store names from lineage information.
 * @param lineage - Optional store lineage information
 * @returns Array of source store names, empty if no lineage or not derived
 */
const lineageSources = (lineage: Option.Option<StoreLineage>) =>
  Option.match(lineage, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (value) => value.sources.map((source) => source.storeName)
  });

type DerivationValidatorService = Context.Tag.Service<typeof DerivationValidator>;
type StoreEventLogService = Context.Tag.Service<typeof StoreEventLog>;
type SyncCheckpointStoreService = Context.Tag.Service<typeof SyncCheckpointStore>;

/**
 * Resolves the derivation status of a store.
 * - "source": Not a derived store
 * - "ready": Derived and all sources are current
 * - "stale": Derived and at least one source is stale
 * - "unknown": Derived but no source information available
 *
 * @param store - Name of the store to check
 * @param lineage - Optional lineage information for the store
 * @param validator - DerivationValidator service for checking staleness
 * @returns An Effect that resolves to the derivation status
 */
const resolveDerivedStatus = (
  store: StoreName,
  lineage: Option.Option<StoreLineage>,
  validator: DerivationValidatorService
) =>
  Effect.gen(function* () {
    if (Option.isNone(lineage) || !lineage.value.isDerived) {
      return "source" as const;
    }
    const sources = lineage.value.sources;
    if (sources.length === 0) {
      return "unknown" as const;
    }
    const staleFlags = yield* Effect.forEach(
      sources,
      (source) => validator.isStale(store, source.storeName),
      { discard: false }
    );
    return staleFlags.some(Boolean) ? ("stale" as const) : ("ready" as const);
  });

/**
 * Resolves the sync status of a source store.
 * - "current": Last event ID matches the latest checkpoint
 * - "stale": Checkpoints exist but don't match current event ID
 * - "unknown": No checkpoints available
 * - "empty": No events in the event log
 *
 * @param storeRef - Reference to the store to check
 * @param eventLog - StoreEventLog service for accessing event log
 * @param checkpoints - SyncCheckpointStore service for accessing checkpoints
 * @returns An Effect that resolves to the sync status
 */
const resolveSyncStatus = (
  storeRef: StoreRef,
  eventLog: StoreEventLogService,
  checkpoints: SyncCheckpointStoreService
) =>
  Effect.gen(function* () {
    const lastEventIdOption = yield* eventLog.getLastEventId(storeRef);
    if (Option.isNone(lastEventIdOption)) {
      return "empty" as const;
    }
    const [timelineCheckpoint, notificationsCheckpoint] = yield* Effect.all([
      checkpoints.load(storeRef, DataSource.timeline()),
      checkpoints.load(storeRef, DataSource.notifications())
    ]);
    const candidates = [timelineCheckpoint, notificationsCheckpoint]
      .filter(Option.isSome)
      .map((option) => option.value);
    if (candidates.length === 0) {
      return "unknown" as const;
    }
    const latest = candidates.sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    )[0];
    if (!latest || !latest.lastEventId) {
      return "stale" as const;
    }
    return latest.lastEventId === lastEventIdOption.value
      ? ("current" as const)
      : ("stale" as const);
  });

/**
 * Effect Context Tag for the Store Statistics service.
 * Calculates detailed statistics and summaries for data stores.
 *
 * This service provides:
 * - Per-store statistics (posts, authors, date ranges, top hashtags/authors, status)
 * - Overall summary across all stores
 * - Derivation status tracking (stale vs current derived stores)
 * - Sync status for source stores
 * - Store size calculations
 *
 * @example
 * ```ts
 * // Use in an Effect program
 * const program = Effect.gen(function* () {
 *   const storeStats = yield* StoreStats;
 *
 *   // Get stats for a specific store
 *   const stats = yield* storeStats.stats(StoreRef.make({
 *     name: "tech-posts",
 *     root: "tech-posts"
 *   }));
 *   console.log(`Store has ${stats.posts} posts from ${stats.authors} authors`);
 *   console.log(`Status: ${stats.status}, Sync: ${stats.syncStatus}`);
 *   console.log(`Top hashtags: ${stats.hashtags.join(", ")}`);
 *
 *   // Get summary of all stores
 *   const summary = yield* storeStats.summary();
 *   console.log(`Total: ${summary.total} stores, ${summary.totalPosts} posts`);
 * });
 *
 * // Provide the layer
 * const runnable = program.pipe(Effect.provide(StoreStats.layer));
 * ```
 */
export class StoreStats extends Context.Tag("@skygent/StoreStats")<
  StoreStats,
  {
    /**
     * Calculates detailed statistics for a single store.
     * Includes post counts, author counts, date ranges, top hashtags/authors,
     * derivation status, sync status, and store size.
     *
     * @param store - Reference to the store to analyze
     * @returns An Effect that resolves to detailed store statistics
     * @throws {StoreIndexError} If accessing store index fails
     * @throws {StoreIoError} If database operations fail
     * @example
     * ```ts
     * const stats = yield* storeStats.stats(StoreRef.make({ name: "my-store", root: "my-store" }));
     * console.log(`${stats.posts} posts, ${stats.authors} authors`);
     * console.log(`Derived: ${stats.derived}, Status: ${stats.status}`);
     * ```
     */
    readonly stats: (
      store: StoreRef
    ) => Effect.Effect<StoreStatsResult, StoreIndexError | StoreIoError>;

    /**
     * Calculates a summary across all stores.
     * Provides aggregate statistics including total counts, sizes, and per-store summaries.
     *
     * @returns An Effect that resolves to a summary of all stores
     * @throws {StoreIndexError} If accessing store index fails
     * @throws {StoreIoError} If database operations fail
     * @example
     * ```ts
     * const summary = yield* storeStats.summary();
     * console.log(`${summary.total} stores (${summary.sources} source, ${summary.derived} derived)`);
     * console.log(`${summary.totalPosts} total posts, ${summary.totalSize} storage used`);
     * ```
     */
    readonly summary: () => Effect.Effect<StoreSummaryResult, StoreIndexError | StoreIoError>;
  }
>() {
  /**
   * Production layer that provides the StoreStats service.
   * Requires multiple services to be provided: StoreIndex, StoreManager,
   * LineageStore, DerivationValidator, StoreEventLog, SyncCheckpointStore,
   * StoreDb, AppConfigService, FileSystem, and Path.
   *
   * The implementation queries SQLite databases for statistics and aggregates
   * information from various sources to provide comprehensive store metrics.
   */
  static readonly layer = Layer.effect(
    StoreStats,
    Effect.gen(function* () {
      const index = yield* StoreIndex;
      const manager = yield* StoreManager;
      const lineageStore = yield* LineageStore;
      const validator = yield* DerivationValidator;
      const eventLog = yield* StoreEventLog;
      const checkpoints = yield* SyncCheckpointStore;
      const storeDb = yield* StoreDb;
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      /**
       * Calculates the total size of a store directory in bytes.
       * Returns 0 if size calculation fails.
       * @param store - Store reference to measure
       * @returns An Effect that resolves to the size in bytes
       */
      const storeSize = (store: StoreRef) => {
        const storePath = path.join(config.storeRoot, store.root);
        return directorySize(fs, path, storePath).pipe(Effect.orElseSucceed(() => 0));
      };

      /**
       * Computes detailed statistics for a store.
       * Aggregates data from lineage, checkpoints, event log, and SQLite database.
       */
      const computeStats = Effect.fn("StoreStats.stats")((store: StoreRef) =>
        Effect.gen(function* () {
          const lineage = yield* lineageStore.get(store.name);
          const status = yield* resolveDerivedStatus(store.name, lineage, validator);
          const syncStatus =
            status === "source"
              ? yield* resolveSyncStatus(store, eventLog, checkpoints)
              : undefined;

          // Ensure store is indexed before querying
          yield* index.count(store);

          // Query SQLite for post statistics, author counts, date ranges, and top items
          const aggregate = yield* storeDb
            .withClient(store, (client) =>
              Effect.gen(function* () {
                // Get basic counts and date range
                const rows = yield* client`SELECT
                    COUNT(*) as posts,
                    COUNT(DISTINCT author) as authors,
                    MIN(created_date) as first,
                    MAX(created_date) as last
                  FROM posts`;
                const row = rows[0] ?? {};

                // Get top authors by post count
                const topAuthorRows = yield* client`SELECT author, COUNT(*) as count
                  FROM posts
                  WHERE author IS NOT NULL
                  GROUP BY author
                  ORDER BY count DESC
                  LIMIT ${TOP_LIMIT}`;

                // Get top hashtags by usage
                const topHashtagRows = yield* client`SELECT tag, COUNT(*) as count
                  FROM post_hashtag
                  GROUP BY tag
                  ORDER BY count DESC
                  LIMIT ${TOP_LIMIT}`;

                return {
                  posts: parseCount(row.posts),
                  authors: parseCount(row.authors),
                  first: typeof row.first === "string" ? row.first : undefined,
                  last: typeof row.last === "string" ? row.last : undefined,
                  topAuthors: topAuthorRows
                    .map((entry) => entry.author)
                    .filter((value): value is string => typeof value === "string"),
                  hashtags: topHashtagRows
                    .map((entry) => entry.tag)
                    .filter((value): value is string => typeof value === "string")
                };
              })
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)));

          const sizeBytes = yield* storeSize(store);
          const dateRange =
            aggregate.first && aggregate.last
              ? { first: aggregate.first, last: aggregate.last }
              : undefined;

          return {
            store: store.name,
            posts: aggregate.posts,
            authors: aggregate.authors,
            hashtags: aggregate.hashtags,
            topAuthors: aggregate.topAuthors,
            derived: isDerived(lineage),
            status,
            sizeBytes,
            ...(dateRange ? { dateRange } : {}),
            ...(syncStatus ? { syncStatus } : {})
          };
        })
      );

      /**
       * Computes a summary across all stores.
       * Aggregates per-store information into overall statistics.
       */
      const summary = Effect.fn("StoreStats.summary")(() =>
        Effect.gen(function* () {
          // Get list of all stores
          const stores = yield* manager.listStores();

          // Compute summary for each store in parallel
          const summaries = yield* Effect.forEach(
            stores,
            (storeMeta) =>
              Effect.gen(function* () {
                const storeRef = StoreRef.make({
                  name: storeMeta.name,
                  root: storeMeta.root
                });
                const lineage = yield* lineageStore.get(storeRef.name);
                const status = yield* resolveDerivedStatus(storeRef.name, lineage, validator);
                const sources = lineageSources(lineage);
                const posts = yield* index.count(storeRef);

                // Build summary entry with conditional source info
                const entry: StoreSummaryEntry = {
                  name: storeRef.name,
                  posts,
                  status,
                  ...(sources.length === 1
                    ? { source: sources[0]! }
                    : sources.length > 1
                      ? { sources }
                      : {})
                };
                return { entry, derived: isDerived(lineage), sizeBytes: yield* storeSize(storeRef) };
              }),
            { discard: false }
          );

          // Aggregate totals
          const total = summaries.length;
          const derivedCount = summaries.filter((entry) => entry.derived).length;
          const sourcesCount = total - derivedCount;
          const totalPosts = summaries.reduce((sum, entry) => sum + entry.entry.posts, 0);
          const totalSizeBytes = summaries.reduce((sum, entry) => sum + entry.sizeBytes, 0);

          return {
            total,
            sources: sourcesCount,
            derived: derivedCount,
            totalPosts,
            totalSizeBytes,
            totalSize: formatBytes(totalSizeBytes),
            stores: summaries.map((entry) => entry.entry)
          };
        })
      );

      return StoreStats.of({ stats: computeStats, summary });
    })
  );
}

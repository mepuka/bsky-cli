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

type StoreStatsResult = {
  readonly store: string;
  readonly posts: number;
  readonly authors: number;
  readonly dateRange?: { readonly first: string; readonly last: string };
  readonly hashtags: ReadonlyArray<string>;
  readonly topAuthors: ReadonlyArray<string>;
  readonly derived: boolean;
  readonly status: "source" | "ready" | "stale" | "unknown";
  readonly syncStatus?: "current" | "stale" | "unknown" | "empty";
  readonly sizeBytes: number;
};

type StoreSummaryEntry = {
  readonly name: string;
  readonly posts: number;
  readonly status: "source" | "ready" | "stale" | "unknown";
  readonly source?: string;
  readonly sources?: ReadonlyArray<string>;
};

type StoreSummaryResult = {
  readonly total: number;
  readonly sources: number;
  readonly derived: number;
  readonly totalPosts: number;
  readonly totalSizeBytes: number;
  readonly totalSize: string;
  readonly stores: ReadonlyArray<StoreSummaryEntry>;
};

const TOP_LIMIT = 5;

const parseCount = (value: unknown) =>
  typeof value === "number" ? value : Number(value ?? 0);

const toStoreIoError = (path: StorePath) => (cause: unknown) => {
  if (typeof cause === "object" && cause !== null) {
    const tagged = cause as { _tag?: string };
    if (tagged._tag === "StoreIoError") {
      return tagged as StoreIoError;
    }
  }
  return StoreIoError.make({ path, cause });
};

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


const isDerived = (lineage: Option.Option<StoreLineage>) =>
  Option.isSome(lineage) && lineage.value.isDerived;

const lineageSources = (lineage: Option.Option<StoreLineage>) =>
  Option.match(lineage, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (value) => value.sources.map((source) => source.storeName)
  });

type DerivationValidatorService = Context.Tag.Service<typeof DerivationValidator>;
type StoreEventLogService = Context.Tag.Service<typeof StoreEventLog>;
type SyncCheckpointStoreService = Context.Tag.Service<typeof SyncCheckpointStore>;

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

export class StoreStats extends Context.Tag("@skygent/StoreStats")<
  StoreStats,
  {
    readonly stats: (
      store: StoreRef
    ) => Effect.Effect<StoreStatsResult, StoreIndexError | StoreIoError>;
    readonly summary: () => Effect.Effect<StoreSummaryResult, StoreIndexError | StoreIoError>;
  }
>() {
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

      const storeSize = (store: StoreRef) => {
        const kvRoot = path.join(config.storeRoot, "kv");
        const storePath = path.join(kvRoot, store.root);
        return directorySize(fs, path, storePath).pipe(Effect.orElseSucceed(() => 0));
      };

      const computeStats = Effect.fn("StoreStats.stats")((store: StoreRef) =>
        Effect.gen(function* () {
          const lineage = yield* lineageStore.get(store.name);
          const status = yield* resolveDerivedStatus(store.name, lineage, validator);
          const syncStatus =
            status === "source"
              ? yield* resolveSyncStatus(store, eventLog, checkpoints)
              : undefined;

          const aggregate = yield* storeDb
            .withClient(store, (client) =>
              Effect.gen(function* () {
                const rows = yield* client`SELECT
                    COUNT(*) as posts,
                    COUNT(DISTINCT author) as authors,
                    MIN(created_date) as first,
                    MAX(created_date) as last
                  FROM posts`;
                const row = rows[0] ?? {};

                const topAuthorRows = yield* client`SELECT author, COUNT(*) as count
                  FROM posts
                  WHERE author IS NOT NULL
                  GROUP BY author
                  ORDER BY count DESC
                  LIMIT ${TOP_LIMIT}`;
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

      const summary = Effect.fn("StoreStats.summary")(() =>
        Effect.gen(function* () {
          const stores = yield* manager.listStores();
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

import { FileSystem, Path } from "@effect/platform";
import { Clock, Duration, Effect, Exit, Option, Ref, Stream } from "effect";
import type { StoreRef } from "../domain/store.js";
import { StoreQuery } from "../domain/events.js";
import { extractImageRefs } from "../domain/embeds.js";
import type { ImageVariant } from "../domain/images.js";
import { CliInputError } from "./errors.js";
import { StoreIndex } from "../services/store-index.js";
import { ImageCache } from "../services/images/image-cache.js";
import { ImageConfig } from "../services/images/image-config.js";
import { ImageRefIndex } from "../services/images/image-ref-index.js";
import { directorySize } from "../services/shared.js";

export type CacheImagesOptions = {
  readonly limit?: number;
  readonly includeThumbnails: boolean;
};

type CacheEntry = {
  readonly url: string;
  readonly variant: ImageVariant;
};

type CacheProgress = {
  readonly cached: number;
  readonly skipped: number;
  readonly errors: number;
};

const initialProgress: CacheProgress = { cached: 0, skipped: 0, errors: 0 };

const buildImageQuery = (order?: "asc" | "desc") =>
  StoreQuery.make({
    filter: { _tag: "HasImages" },
    ...(order ? { order } : {})
  });

const entryKey = (entry: CacheEntry) => `${entry.variant}:${entry.url}`;

const extractEntries = (post: { readonly embed?: unknown }, includeThumbnails: boolean) => {
  const images = extractImageRefs(post.embed as any);
  const entries: CacheEntry[] = [];
  for (const image of images) {
    entries.push({ url: image.fullsizeUrl, variant: "original" });
    if (includeThumbnails) {
      entries.push({ url: image.thumbUrl, variant: "thumb" });
    }
  }
  return entries;
};

const mapProgress = (progress: CacheProgress, delta: CacheProgress): CacheProgress => ({
  cached: progress.cached + delta.cached,
  skipped: progress.skipped + delta.skipped,
  errors: progress.errors + delta.errors
});

const ensureCacheEnabled = (config: { readonly enabled: boolean }) => {
  if (!config.enabled) {
    return CliInputError.make({
      message: "Image cache is disabled. Set SKYGENT_IMAGE_CACHE_ENABLED=true to enable caching.",
      cause: { enabled: config.enabled }
    });
  }
};

const buildEntryStream = (
  store: StoreRef,
  includeThumbnails: boolean,
  limit: Option.Option<number>
) =>
  StoreIndex.pipe(
    Effect.map((index) =>
      index.query(
        store,
        buildImageQuery(Option.isSome(limit) ? "desc" : undefined)
      )
    ),
    Effect.map((stream) =>
      Option.match(limit, {
        onNone: () => stream,
        onSome: (value) => stream.pipe(Stream.take(value))
      })
    ),
    Effect.map((stream) =>
      stream.pipe(Stream.mapConcat((post) => extractEntries(post, includeThumbnails)))
    )
  );

export const cacheStoreImages = (
  store: StoreRef,
  options: CacheImagesOptions
) =>
  Effect.gen(function* () {
    const config = yield* ImageConfig;
    const cacheEnabledError = ensureCacheEnabled(config);
    if (cacheEnabledError) {
      return yield* cacheEnabledError;
    }
    const cache = yield* ImageCache;
    const seenRef = yield* Ref.make(new Set<string>());

    const stream = yield* buildEntryStream(
      store,
      options.includeThumbnails,
      Option.fromNullable(options.limit)
    );

    const processEntry = (entry: CacheEntry) =>
      Effect.gen(function* () {
        const shouldProcess = yield* Ref.modify(seenRef, (seen) => {
          const key = entryKey(entry);
          if (seen.has(key)) {
            return [false, seen] as const;
          }
          const next = new Set(seen);
          next.add(key);
          return [true, next] as const;
        });
        if (!shouldProcess) {
          return { cached: 0, skipped: 1, errors: 0 } satisfies CacheProgress;
        }
        const exit = yield* cache.get(entry.url, entry.variant).pipe(Effect.exit);
        return Exit.isSuccess(exit)
          ? { cached: 1, skipped: 0, errors: 0 }
          : { cached: 0, skipped: 0, errors: 1 };
      });

    const progress = yield* stream.pipe(
      Stream.mapEffect(processEntry, { concurrency: 10 }),
      Stream.runFold(initialProgress, mapProgress)
    );

    return {
      store: store.name,
      ...progress
    };
  });

export const cacheStatusForStore = (
  store: StoreRef,
  options: CacheImagesOptions
) =>
  Effect.gen(function* () {
    const cache = yield* ImageCache;
    const config = yield* ImageConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seenRef = yield* Ref.make(new Set<string>());

    const stream = yield* buildEntryStream(
      store,
      options.includeThumbnails,
      Option.fromNullable(options.limit)
    );

    const checkEntry = (entry: CacheEntry) =>
      Effect.gen(function* () {
        const shouldProcess = yield* Ref.modify(seenRef, (seen) => {
          const key = entryKey(entry);
          if (seen.has(key)) {
            return [false, seen] as const;
          }
          const next = new Set(seen);
          next.add(key);
          return [true, next] as const;
        });
        if (!shouldProcess) {
          return { cached: 0, skipped: 0, errors: 0 } satisfies CacheProgress;
        }
        const cached = yield* cache.getCached(entry.url, entry.variant);
        return Option.isSome(cached)
          ? { cached: 1, skipped: 0, errors: 0 }
          : { cached: 0, skipped: 1, errors: 0 };
      });

    const progress = yield* stream.pipe(
      Stream.mapEffect(checkEntry, { concurrency: 10 }),
      Stream.runFold(initialProgress, mapProgress)
    );

    const cacheRoot = config.cacheRoot;
    const exists = yield* fs.exists(cacheRoot).pipe(Effect.orElseSucceed(() => false));
    const cacheBytes = exists ? yield* directorySize(fs, path, cacheRoot) : 0;

    return {
      store: store.name,
      totalImages: progress.cached + progress.skipped,
      cachedImages: progress.cached,
      missingImages: progress.skipped,
      cacheBytes,
      cacheRoot,
      includeThumbnails: options.includeThumbnails,
      ...(options.limit !== undefined ? { limit: options.limit } : {})
    };
  });

export const cacheSweepForStore = (
  store: StoreRef,
  options: CacheImagesOptions & { readonly remove?: boolean }
) =>
  Effect.gen(function* () {
    const cache = yield* ImageCache;
    const config = yield* ImageConfig;
    const refIndex = yield* ImageRefIndex;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seenRef = yield* Ref.make(new Set<string>());
    const referencedRef = yield* Ref.make(new Set<string>());

    const stream = yield* buildEntryStream(
      store,
      options.includeThumbnails,
      Option.none()
    );

    const collectEntry = (entry: CacheEntry) =>
      Effect.gen(function* () {
        const shouldProcess = yield* Ref.modify(seenRef, (seen) => {
          const key = entryKey(entry);
          if (seen.has(key)) {
            return [false, seen] as const;
          }
          const next = new Set(seen);
          next.add(key);
          return [true, next] as const;
        });
        if (!shouldProcess) {
          return { cached: 0, skipped: 0, errors: 0 } satisfies CacheProgress;
        }
        const cached = yield* cache.getCached(entry.url, entry.variant);
        if (Option.isSome(cached)) {
          const normalized = path.normalize(cached.value.path);
          yield* Ref.update(referencedRef, (set) => {
            const next = new Set(set);
            next.add(normalized);
            return next;
          });
          return { cached: 1, skipped: 0, errors: 0 } satisfies CacheProgress;
        }
        return { cached: 0, skipped: 1, errors: 0 } satisfies CacheProgress;
      });

    const progress = yield* stream.pipe(
      Stream.mapEffect(collectEntry, { concurrency: 10 }),
      Stream.runFold(initialProgress, mapProgress)
    );
    const referenced = yield* Ref.get(referencedRef);

    const cacheRoot = config.cacheRoot;
    const exists = yield* fs.exists(cacheRoot).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {
        store: store.name,
        referencedFiles: referenced.size,
        scannedFiles: 0,
        orphanedFiles: 0,
        removedFiles: 0,
        includeThumbnails: options.includeThumbnails,
        dryRun: !options.remove
      };
    }

    const entries = yield* fs
      .readDirectory(cacheRoot, { recursive: true })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const files = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const absolute = path.isAbsolute(entry)
            ? entry
            : path.join(cacheRoot, entry);
          const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
          if (!info || info.type !== "File") {
            return Option.none<string>();
          }
          const relative = path.isAbsolute(entry)
            ? path.relative(cacheRoot, absolute)
            : entry;
          const normalized = path.normalize(relative);
          if (normalized === "meta" || normalized.startsWith(`meta${path.sep}`)) {
            return Option.none<string>();
          }
          if (!options.includeThumbnails && normalized.startsWith(`thumb${path.sep}`)) {
            return Option.none<string>();
          }
          return Option.some(normalized);
        }),
      { concurrency: 20 }
    );
    const fileList = files.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
    const orphaned = fileList.filter((file) => !referenced.has(file));

    if (options.remove && orphaned.length > 0) {
      yield* Effect.forEach(
        orphaned,
        (relativePath) =>
          Effect.gen(function* () {
            yield* fs
              .remove(path.join(cacheRoot, relativePath), { force: true })
              .pipe(Effect.orElseSucceed(() => undefined));
            yield* refIndex
              .remove(relativePath)
              .pipe(Effect.orElseSucceed(() => undefined));
          }),
        { discard: true, concurrency: 10 }
      );
    }

    return {
      store: store.name,
      referencedImages: progress.cached,
      missingImages: progress.skipped,
      referencedFiles: referenced.size,
      scannedFiles: fileList.length,
      orphanedFiles: orphaned.length,
      removedFiles: options.remove ? orphaned.length : 0,
      includeThumbnails: options.includeThumbnails,
      dryRun: !options.remove
    };
  });

type CacheTtlSweepProgress = {
  readonly scanned: number;
  readonly expired: number;
  readonly removed: number;
};

const initialTtlProgress: CacheTtlSweepProgress = { scanned: 0, expired: 0, removed: 0 };

const mergeTtlProgress = (
  left: CacheTtlSweepProgress,
  right: CacheTtlSweepProgress
): CacheTtlSweepProgress => ({
  scanned: left.scanned + right.scanned,
  expired: left.expired + right.expired,
  removed: left.removed + right.removed
});

export const cacheTtlSweep = (options: { readonly remove?: boolean; readonly includeThumbnails?: boolean }) =>
  Effect.gen(function* () {
    const config = yield* ImageConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const refIndex = yield* ImageRefIndex;
    const now = yield* Clock.currentTimeMillis;
    const ttlMillis = Duration.toMillis(config.cacheTtl);
    const includeThumbnails = options.includeThumbnails ?? true;

    const roots = includeThumbnails
      ? [config.originalsRoot, config.thumbsRoot]
      : [config.originalsRoot];

    const sweepRoot = (root: string) =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return initialTtlProgress;
        const entries = yield* fs
          .readDirectory(root, { recursive: true })
          .pipe(Effect.orElseSucceed(() => [] as Array<string>));
        return yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const absolute = path.isAbsolute(entry) ? entry : path.join(root, entry);
              const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
              if (!info || info.type !== "File") {
                return initialTtlProgress;
              }
              const mtime = Option.getOrUndefined(info.mtime);
              const expired = ttlMillis === 0
                ? true
                : mtime
                  ? now - mtime.getTime() >= ttlMillis
                  : false;
              if (!expired) {
                return { scanned: 1, expired: 0, removed: 0 } satisfies CacheTtlSweepProgress;
              }
              if (!options.remove) {
                return { scanned: 1, expired: 1, removed: 0 } satisfies CacheTtlSweepProgress;
              }
              const removed = yield* fs
                .remove(absolute, { force: true })
                .pipe(
                  Effect.as(1),
                  Effect.orElseSucceed(() => 0)
                );
              if (removed > 0) {
                const relative = path.relative(config.cacheRoot, absolute);
                yield* refIndex
                  .remove(relative)
                  .pipe(Effect.orElseSucceed(() => undefined));
              }
              return {
                scanned: 1,
                expired: 1,
                removed
              } satisfies CacheTtlSweepProgress;
            }),
          { concurrency: 20 }
        ).pipe(Effect.map((items) => items.reduce(mergeTtlProgress, initialTtlProgress)));
      });

    const progress = yield* Effect.forEach(
      roots,
      (root) => sweepRoot(root),
      { concurrency: 2 }
    ).pipe(Effect.map((items) => items.reduce(mergeTtlProgress, initialTtlProgress)));

    return {
      cacheRoot: config.cacheRoot,
      ttlMillis,
      scannedFiles: progress.scanned,
      expiredFiles: progress.expired,
      removedFiles: progress.removed,
      includeThumbnails,
      dryRun: !options.remove
    };
  });

export const cleanImageCache = (force: boolean) =>
  Effect.gen(function* () {
    if (!force) {
      return yield* CliInputError.make({
        message: "--force is required to clear the image cache.",
        cause: { force }
      });
    }
    const config = yield* ImageConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(config.cacheRoot, { recursive: true }).pipe(
      Effect.catchTag("SystemError", (error) =>
        error.reason === "NotFound" ? Effect.void : Effect.fail(error)
      )
    );
    yield* fs.makeDirectory(config.cacheRoot, { recursive: true, mode: 0o700 });
    return { cleared: true, cacheRoot: config.cacheRoot };
  });

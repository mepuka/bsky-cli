import { FileSystem, Path } from "@effect/platform";
import { Effect, Exit, Option, Ref, Stream } from "effect";
import type { StoreRef } from "../domain/store.js";
import { StoreQuery } from "../domain/events.js";
import { extractImageRefs } from "../domain/embeds.js";
import type { ImageVariant } from "../domain/images.js";
import { CliInputError } from "./errors.js";
import { StoreIndex } from "../services/store-index.js";
import { ImageCache } from "../services/images/image-cache.js";
import { ImageConfig } from "../services/images/image-config.js";
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
    yield* fs.makeDirectory(config.cacheRoot, { recursive: true });
    return { cleared: true, cacheRoot: config.cacheRoot };
  });

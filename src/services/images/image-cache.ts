import * as ExperimentalRequestResolver from "@effect/experimental/RequestResolver";
import * as Persistence from "@effect/experimental/Persistence";
import { Duration, Effect, Exit, Option, PrimaryKey, Request, RequestResolver, Schema } from "effect";
import { createHash } from "node:crypto";
import { ImageAsset, ImageVariant } from "../../domain/images.js";
import { ImageCacheError, isImageArchiveError, isImageCacheError, isImageFetchError } from "../../domain/errors.js";
import { messageFromCause } from "../shared.js";
import { ImageArchive } from "./image-archive.js";
import { ImageFetcher } from "./image-fetcher.js";
import { ImageConfig } from "./image-config.js";
import { ImageRefIndex } from "./image-ref-index.js";

const cacheKey = (url: string, variant: ImageVariant) => `${variant}:${url}`;
const cacheKeyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");

class ImageCacheRequest extends Schema.TaggedRequest<ImageCacheRequest>()(
  "ImageCacheRequest",
  {
    success: ImageAsset,
    failure: ImageCacheError,
    payload: {
      url: Schema.String,
      variant: ImageVariant
    }
  }
) implements Persistence.Persistable<typeof ImageAsset, typeof ImageCacheError> {
  [PrimaryKey.symbol]() {
    return `image:${cacheKeyHash(cacheKey(this.url, this.variant))}`;
  }
}

const toCacheError = (key: string, operation: string) => (cause: unknown) => {
  if (isImageCacheError(cause)) {
    return cause;
  }
  if (isImageFetchError(cause)) {
    const error = cause;
    return ImageCacheError.make({
      message: error.message,
      key,
      operation: error.operation ?? operation,
      status: error.status
    });
  }
  if (isImageArchiveError(cause)) {
    const error = cause;
    return ImageCacheError.make({
      message: error.message,
      key,
      operation: error.operation ?? operation
    });
  }

  return ImageCacheError.make({
    message: messageFromCause("Image cache failed", cause),
    key,
    operation
  });
};

export class ImageCache extends Effect.Service<ImageCache>()("@skygent/ImageCache", {
  scoped: Effect.gen(function* () {
      const config = yield* ImageConfig;
      const fetcher = yield* ImageFetcher;
      const archive = yield* ImageArchive;
      const refIndex = yield* ImageRefIndex;
      const persistence = yield* Persistence.ResultPersistence;

      const timeToLive = (
        _request: Persistence.ResultPersistence.KeyAny,
        exit: Exit.Exit<unknown, unknown>
      ) => (Exit.isSuccess(exit) ? config.cacheTtl : config.failureTtl);

      const store = yield* persistence.make({
        storeId: "image-cache",
        timeToLive
      });

      const requestCache =
        config.memCapacity > 0 && Duration.toMillis(config.memTtl) > 0
          ? Option.some(
              yield* Request.makeCache({
                capacity: config.memCapacity,
                timeToLive: config.memTtl
              })
            )
          : Option.none();

      const resolveRequest = (request: ImageCacheRequest) =>
        fetcher
          .fetch(request.url)
          .pipe(
            Effect.flatMap((result) =>
              archive.store({
                url: result.url,
                bytes: result.bytes,
                variant: request.variant,
                ...(result.contentType !== undefined
                  ? { contentType: result.contentType }
                  : {})
              })
            ),
            Effect.mapError(
              toCacheError(cacheKey(request.url, request.variant), "imageCacheLookup")
            )
          );

      const baseResolver = RequestResolver.makeBatched<ImageCacheRequest, never>(
        (requests) =>
          Effect.forEach(
            requests,
            (request) => resolveRequest(request).pipe(Effect.exit),
            { concurrency: "unbounded" }
          ).pipe(
            Effect.flatMap((exits) =>
              Effect.forEach(
                exits,
                (exit, index) => Request.complete(requests[index]!, exit as any),
                { discard: true }
              )
            ),
            Effect.withRequestCaching(false)
          )
      );

      const resolver = yield* ExperimentalRequestResolver.persisted(baseResolver, {
        storeId: "image-cache",
        timeToLive
      });

      const get = Effect.fn("ImageCache.get")((url: string, variant: ImageVariant = "original") => {
        const request = new ImageCacheRequest({ url, variant });
        const loadCached = store
          .get(request)
          .pipe(Effect.mapError(toCacheError(cacheKey(url, variant), "imageCacheGet")));
        const effect = Effect.request(request, resolver).pipe(
          Effect.mapError(toCacheError(cacheKey(url, variant), "imageCacheGet"))
        );
        const withCache = Option.match(requestCache, {
          onNone: () => effect,
          onSome: (cache) =>
            effect.pipe(
              Effect.withRequestCaching(true),
              Effect.withRequestCache(cache)
            )
        });
        return loadCached.pipe(
          Effect.map((cached) => Option.isSome(cached) && Exit.isSuccess(cached.value)),
          Effect.flatMap((wasCached) =>
            withCache.pipe(
              Effect.tap((asset) =>
                wasCached ? refIndex.ensure(asset.path) : refIndex.increment(asset.path)
              )
            )
          )
        );
      });

      const invalidate = Effect.fn("ImageCache.invalidate")(
        (url: string, variant: ImageVariant = "original") => {
          const request = new ImageCacheRequest({ url, variant });
          const key = cacheKey(url, variant);
          const removeArchive = store
            .get(request)
            .pipe(
              Effect.mapError(toCacheError(key, "imageCacheInvalidate")),
              Effect.flatMap((cached) =>
                Option.match(cached, {
                  onNone: () => Effect.void,
                  onSome: (exit) =>
                    Exit.isSuccess(exit)
                      ? refIndex
                          .decrement(exit.value.path)
                          .pipe(
                            Effect.mapError(
                              toCacheError(key, "imageCacheInvalidate")
                            ),
                            Effect.flatMap((count) =>
                              count === 0
                                ? archive
                                    .remove(exit.value)
                                    .pipe(
                                      Effect.mapError(
                                        toCacheError(key, "imageCacheInvalidate")
                                      )
                                    )
                                : Effect.void
                            )
                          )
                      : Effect.void
                })
              ),
              Effect.catchAll((error) =>
                Effect.logWarning("Image archive removal failed during invalidation", { error })
              )
            );
          const removeStore = store
            .remove(request)
            .pipe(Effect.mapError(toCacheError(key, "imageCacheInvalidate")));
          const removeMemory = Option.match(requestCache, {
            onNone: () => Effect.void,
            onSome: (cache) => cache.invalidate(request)
          });
          return removeArchive.pipe(
            Effect.zipRight(removeStore),
            Effect.zipRight(removeMemory)
          );
        }
      );

      const getCached = Effect.fn("ImageCache.getCached")(
        (url: string, variant: ImageVariant = "original") =>
          store
            .get(new ImageCacheRequest({ url, variant }))
            .pipe(
              Effect.mapError(
                toCacheError(cacheKey(url, variant), "imageCacheGetCached")
              ),
              Effect.flatMap((cached) =>
                Option.match(cached, {
                  onNone: () => Effect.succeed(Option.none<ImageAsset>()),
                  onSome: (exit) =>
                    Exit.isSuccess(exit)
                      ? archive.exists(exit.value).pipe(
                          Effect.mapError(
                            toCacheError(cacheKey(url, variant), "imageCacheGetCached")
                          ),
                          Effect.flatMap((exists) =>
                            exists
                              ? Effect.succeed(Option.some(exit.value))
                              : invalidate(url, variant).pipe(
                                  Effect.as(Option.none<ImageAsset>())
                                )
                          )
                        )
                      : Effect.succeed(Option.none<ImageAsset>())
                })
              )
            )
      );

      return { get, getCached, invalidate };
    })
}) {
  static readonly layer = ImageCache.Default;
}

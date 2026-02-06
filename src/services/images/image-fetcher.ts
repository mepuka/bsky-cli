import { Headers, HttpClient, HttpClientError } from "@effect/platform";
import {
  Config,
  Duration,
  Effect,
  Option,
  Request,
  RequestResolver
} from "effect";
import * as ExperimentalRequestResolver from "@effect/experimental/RequestResolver";
import { ImageFetchError, isImageFetchError } from "../../domain/errors.js";
import { messageFromCause, validateNonNegative, validatePositive } from "../shared.js";

type CacheConfig = {
  readonly capacity: number;
  readonly timeToLive: Duration.Duration;
};

export type ImageFetchResult = {
  readonly url: string;
  readonly status: number;
  readonly contentType?: string;
  readonly contentLength?: number;
  readonly bytes: Uint8Array;
};

export class ImageFetchRequest extends Request.TaggedClass("ImageFetch")<
  ImageFetchResult,
  ImageFetchError,
  { readonly url: string }
> {}

const parseContentLength = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

const normalizeContentType = (value: string | undefined) =>
  value ? value.split(";")[0]?.trim() : undefined;

const toImageFetchError = (url: string, operation: string) => (cause: unknown) => {
  if (isImageFetchError(cause)) {
    return cause;
  }
  if (HttpClientError.isHttpClientError(cause)) {
    const status = cause instanceof HttpClientError.ResponseError
      ? cause.response.status
      : undefined;
    return ImageFetchError.make({
      message: cause.message,
      url,
      status,
      operation,
      cause
    });
  }
  return ImageFetchError.make({
    message: messageFromCause("Image fetch failed", cause),
    url,
    operation,
    cause
  });
};

const ensureImageContentType = (url: string, value: string | undefined) => {
  if (!value || !value.startsWith("image/")) {
    return ImageFetchError.make({
      message: `Unexpected content-type for ${url}: ${value ?? "unknown"}`,
      url,
      operation: "imageFetch",
      cause: value
    });
  }
};

export class ImageFetcher extends Effect.Service<ImageFetcher>()("@skygent/ImageFetcher", {
  scoped: Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const concurrency = yield* Config.integer("SKYGENT_IMAGE_FETCH_CONCURRENCY").pipe(
        Config.withDefault(8)
      );
      const concurrencyError = validatePositive(
        "SKYGENT_IMAGE_FETCH_CONCURRENCY",
        concurrency
      );
      if (concurrencyError) {
        return yield* concurrencyError;
      }

      const maxBatchSizeRaw = yield* Config.integer(
        "SKYGENT_IMAGE_FETCH_BATCH_SIZE"
      ).pipe(Config.withDefault(0));
      const maxBatchSize = maxBatchSizeRaw > 0 ? maxBatchSizeRaw : undefined;

      const batchWindow = yield* Config.duration(
        "SKYGENT_IMAGE_FETCH_BATCH_WINDOW"
      ).pipe(Config.withDefault(Duration.millis(5)));
      const batchWindowMs = Duration.toMillis(batchWindow);

      const maxBytes = yield* Config.integer("SKYGENT_IMAGE_FETCH_MAX_BYTES").pipe(
        Config.withDefault(10_000_000)
      );
      const maxBytesError = validateNonNegative(
        "SKYGENT_IMAGE_FETCH_MAX_BYTES",
        maxBytes
      );
      if (maxBytesError) {
        return yield* maxBytesError;
      }

      const timeout = yield* Config.duration("SKYGENT_IMAGE_FETCH_TIMEOUT").pipe(
        Config.withDefault(Duration.seconds(30))
      );

      const cacheCapacity = yield* Config.integer(
        "SKYGENT_IMAGE_REQUEST_CACHE_CAPACITY"
      ).pipe(Config.withDefault(2048));
      const cacheTtl = yield* Config.duration(
        "SKYGENT_IMAGE_REQUEST_CACHE_TTL"
      ).pipe(Config.withDefault(Duration.minutes(10)));

      const cacheConfig =
        cacheCapacity > 0 && Duration.toMillis(cacheTtl) > 0
          ? Option.some<CacheConfig>({ capacity: cacheCapacity, timeToLive: cacheTtl })
          : Option.none<CacheConfig>();

      const cache = yield* Option.match(cacheConfig, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (config) => Request.makeCache(config).pipe(Effect.map(Option.some))
      });

      const fetchOne = Effect.fn("ImageFetcher.fetchOne")((request: ImageFetchRequest) =>
        Effect.gen(function* () {
          const response = yield* http
            .get(request.url, { headers: { accept: "image/*" } })
            .pipe(Effect.mapError(toImageFetchError(request.url, "imageFetch")));

          if (response.status < 200 || response.status >= 400) {
            return yield* ImageFetchError.make({
              message: `Unexpected status ${response.status} for ${request.url}`,
              url: request.url,
              status: response.status,
              operation: "imageFetch",
              cause: response.status
            });
          }

          const contentTypeHeader = Option.getOrUndefined(
            Headers.get(response.headers, "content-type")
          );
          const contentType = normalizeContentType(contentTypeHeader);
          const contentTypeError = ensureImageContentType(request.url, contentType);
          if (contentTypeError) {
            return yield* contentTypeError;
          }

          const contentLengthHeader = Option.getOrUndefined(
            Headers.get(response.headers, "content-length")
          );
          const contentLength = parseContentLength(contentLengthHeader);

          if (maxBytes > 0 && contentLength !== undefined && contentLength > maxBytes) {
            return yield* ImageFetchError.make({
              message: `Image exceeds max size (${contentLength} > ${maxBytes})`,
              url: request.url,
              status: response.status,
              operation: "imageFetch",
              cause: contentLength
            });
          }

          const buffer = yield* response.arrayBuffer.pipe(
            Effect.timeoutFail({
              duration: timeout,
              onTimeout: () =>
                ImageFetchError.make({
                  message: `Image fetch timed out after ${Duration.toMillis(timeout)}ms`,
                  url: request.url,
                  operation: "imageFetch",
                  cause: timeout
                })
            }),
            Effect.mapError(toImageFetchError(request.url, "imageFetch"))
          );

          const bytes = new Uint8Array(buffer);

          if (maxBytes > 0 && bytes.length > maxBytes) {
            return yield* ImageFetchError.make({
              message: `Image exceeds max size (${bytes.length} > ${maxBytes})`,
              url: request.url,
              status: response.status,
              operation: "imageFetch",
              cause: bytes.length
            });
          }

          const result: ImageFetchResult = {
            url: request.url,
            status: response.status,
            bytes,
            ...(contentType !== undefined ? { contentType } : {}),
            ...(contentLength !== undefined ? { contentLength } : {})
          };

          return result;
        })
      );

      const baseResolver = RequestResolver.makeBatched<ImageFetchRequest, never>(
        (requests) =>
          Effect.forEach(
            requests,
            (request) => fetchOne(request).pipe(Effect.exit),
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
      ).pipe(RequestResolver.batchN(concurrency));

      const resolver =
        batchWindowMs > 0
          ? yield* ExperimentalRequestResolver.dataLoader(baseResolver, {
              window: batchWindow,
              ...(maxBatchSize ? { maxBatchSize } : {})
            })
          : baseResolver;

      const fetch = Effect.fn("ImageFetcher.fetch")((url: string) => {
        const effect = Effect.request(new ImageFetchRequest({ url }), resolver);
        return Option.match(cache, {
          onNone: () => effect,
          onSome: (cache) =>
            effect.pipe(
              Effect.withRequestCaching(true),
              Effect.withRequestCache(cache)
            )
        });
      });

      const fetchMany = Effect.fn("ImageFetcher.fetchMany")(
        (urls: ReadonlyArray<string>) =>
          Effect.forEach(urls, (url) => fetch(url), { concurrency: "unbounded" })
      );

      return { fetch, fetchMany };
    })
}) {
  static readonly layer = ImageFetcher.Default;
}

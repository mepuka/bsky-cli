import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient } from "@effect/platform";
import type { HttpClientRequest } from "@effect/platform/HttpClientRequest";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { ImageFetcher } from "../../src/services/images/image-fetcher.js";

const envProvider = (entries: Array<readonly [string, string]>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(entries)));

const makeHttpLayer = (
  handler: (request: HttpClientRequest) => Response
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url, _signal, _fiber) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))
    )
  );

describe("ImageFetcher", () => {
  test("caches repeated fetches", async () => {
    let calls = 0;
    const httpLayer = makeHttpLayer(() => {
      calls += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "3"
        }
      });
    });

    const layer = ImageFetcher.layer.pipe(
      Layer.provide(httpLayer),
      Layer.provide(
        envProvider([
          ["SKYGENT_IMAGE_REQUEST_CACHE_CAPACITY", "10"],
          ["SKYGENT_IMAGE_REQUEST_CACHE_TTL", "10 seconds"],
          ["SKYGENT_IMAGE_FETCH_BATCH_WINDOW", "0 millis"],
          ["SKYGENT_IMAGE_FETCH_CONCURRENCY", "5"]
        ])
      )
    );

    const program = Effect.gen(function* () {
      const fetcher = yield* ImageFetcher;
      const first = yield* fetcher.fetch("https://example.com/image.png");
      const second = yield* fetcher.fetch("https://example.com/image.png");
      return { first, second };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(calls).toBe(1);
    expect(result.first.bytes.length).toBe(3);
    expect(result.second.bytes.length).toBe(3);
  });

  test("rejects non-image content types", async () => {
    const httpLayer = makeHttpLayer(() =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "text/plain" }
      })
    );

    const layer = ImageFetcher.layer.pipe(
      Layer.provide(httpLayer),
      Layer.provide(
        envProvider([
          ["SKYGENT_IMAGE_FETCH_BATCH_WINDOW", "0 millis"],
          ["SKYGENT_IMAGE_FETCH_CONCURRENCY", "5"]
        ])
      )
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const fetcher = yield* ImageFetcher;
          return yield* fetcher.fetch("https://example.com/text.txt");
        }).pipe(Effect.provide(layer))
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("ImageFetchError");
    }
  });

  test("enforces max byte limits", async () => {
    const httpLayer = makeHttpLayer(() =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4"
        }
      })
    );

    const layer = ImageFetcher.layer.pipe(
      Layer.provide(httpLayer),
      Layer.provide(
        envProvider([
          ["SKYGENT_IMAGE_FETCH_MAX_BYTES", "2"],
          ["SKYGENT_IMAGE_FETCH_BATCH_WINDOW", "0 millis"],
          ["SKYGENT_IMAGE_FETCH_CONCURRENCY", "5"]
        ])
      )
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const fetcher = yield* ImageFetcher;
          return yield* fetcher.fetch("https://example.com/large.png");
        }).pipe(Effect.provide(layer))
      )
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("ImageFetchError");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Schema } from "effect";
import { parseFilterDsl } from "../../src/cli/filter-dsl.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { StoreName } from "../../src/domain/primitives.js";

const emptyLibraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.of({
    list: () => Effect.succeed([]),
    get: (name) => Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

const techName = Schema.decodeUnknownSync(StoreName)("tech");
const namedLibraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.of({
    list: () => Effect.succeed(["tech"]),
    get: (name) =>
      name === techName
        ? Effect.succeed({ _tag: "Hashtag", tag: "#tech" })
        : Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

describe("filter DSL", () => {
  test("parses hashtag + author with AND", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("hashtag:#ai AND author:user.bsky.social").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "And",
      left: { _tag: "Hashtag", tag: "#ai" },
      right: { _tag: "Author", handle: "user.bsky.social" }
    });
  });

  test("rejects unknown filter type", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        parseFilterDsl("unknown:stuff").pipe(Effect.provide(emptyLibraryLayer))
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("Unknown filter type");
    }
  });

  test("parses date range filter", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("date:2024-01-01T00:00:00Z..2024-01-31T00:00:00Z").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result._tag).toBe("DateRange");
    if (result._tag === "DateRange") {
      expect(result.start.toISOString()).toBe("2024-01-01T00:00:00.000Z");
      expect(result.end.toISOString()).toBe("2024-01-31T00:00:00.000Z");
    }
  });

  test("parses links filter with default policy", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("links").pipe(Effect.provide(emptyLibraryLayer))
    );

    expect(result).toMatchObject({
      _tag: "HasValidLinks",
      onError: { _tag: "Exclude" }
    });
  });

  test("parses links filter with onError option", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("links:onError=include").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "HasValidLinks",
      onError: { _tag: "Include" }
    });
  });

  test("parses trending filter with onError override", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("trending:#ai,onError=exclude").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Trending",
      tag: "#ai",
      onError: { _tag: "Exclude" }
    });
  });

  test("parses llm filter with retry policy", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl(
        "llm:\"score tech posts\",minConfidence=0.6,onError=retry,maxRetries=3,baseDelay=\"1 second\""
      ).pipe(Effect.provide(emptyLibraryLayer))
    );

    expect(result._tag).toBe("Llm");
    if (result._tag === "Llm") {
      expect(result.prompt).toBe("score tech posts");
      expect(result.minConfidence).toBeCloseTo(0.6);
      expect(result.onError._tag).toBe("Retry");
      if (result.onError._tag === "Retry") {
        expect(result.onError.maxRetries).toBe(3);
        expect(Duration.toMillis(result.onError.baseDelay)).toBe(1000);
      }
    }
  });

  test("rejects retry policy missing baseDelay", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        parseFilterDsl("llm:\"hi\",onError=retry,maxRetries=2").pipe(
          Effect.provide(emptyLibraryLayer)
        )
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("baseDelay");
    }
  });

  test("parses named filter references", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("@tech").pipe(Effect.provide(namedLibraryLayer))
    );

    expect(result).toMatchObject({ _tag: "Hashtag", tag: "#tech" });
  });

  test("parses author lists", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("authorin:alice.bsky.social,bob.bsky.social").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "AuthorIn",
      handles: ["alice.bsky.social", "bob.bsky.social"]
    });
  });
});

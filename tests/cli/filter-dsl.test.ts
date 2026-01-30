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

  test("parses from: alias for author", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("from:alice.bsky.social").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Author",
      handle: "alice.bsky.social"
    });
  });

  test("parses text:contains alias", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("text:contains \"hello\"").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Contains",
      text: "hello"
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

  test("rejects label filter with guidance", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        parseFilterDsl("label:nsfw").pipe(Effect.provide(emptyLibraryLayer))
      )
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("not supported");
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

  test("parses engagement options with key=value syntax", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("engagement:minLikes=100,minReplies=5").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Engagement",
      minLikes: 100,
      minReplies: 5
    });
  });

  test("parses regex with spaces", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("regex:/red card|yellow card/i").pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: ["red card|yellow card"],
      flags: "i"
    });
  });

  test("parses regex with parentheses", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl(String.raw`regex:/\b(Saka|Rice)\b/i`).pipe(
        Effect.provide(emptyLibraryLayer)
      )
    );

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: [String.raw`\b(Saka|Rice)\b`],
      flags: "i"
    });
  });

  test("parses regex with quantifier comma", async () => {
    const result = await Effect.runPromise(
      parseFilterDsl("regex:/a{1,3}/").pipe(Effect.provide(emptyLibraryLayer))
    );

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: ["a{1,3}"]
    });
  });
});

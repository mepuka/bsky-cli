import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, TestClock, TestContext } from "effect";
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

const runWithClock = <A>(
  effect: Effect.Effect<A, unknown>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(new Date("2026-01-31T00:00:00Z"));
      return yield* effect;
    }).pipe(Effect.provide(TestContext.TestContext))
  );

const runDsl = (input: string, layer = emptyLibraryLayer) =>
  runWithClock(
    parseFilterDsl(input).pipe(Effect.provide(layer))
  );

const runDslEither = (input: string, layer = emptyLibraryLayer) =>
  runWithClock(
    Effect.either(parseFilterDsl(input)).pipe(Effect.provide(layer))
  );

describe("filter DSL", () => {
  test("parses hashtag + author with AND", async () => {
    const result = await runDsl("hashtag:#ai AND author:user.bsky.social");

    expect(result).toMatchObject({
      _tag: "And",
      left: { _tag: "Hashtag", tag: "#ai" },
      right: { _tag: "Author", handle: "user.bsky.social" }
    });
  });

  test("parses from: alias for author", async () => {
    const result = await runDsl("from:alice.bsky.social");

    expect(result).toMatchObject({
      _tag: "Author",
      handle: "alice.bsky.social"
    });
  });

  test("parses text:contains alias", async () => {
    const result = await runDsl("text:contains \"hello\"");

    expect(result).toMatchObject({
      _tag: "Contains",
      text: "hello"
    });
  });

  test("rejects unknown filter type", async () => {
    const result = await runDslEither("unknown:stuff");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("Unknown filter type");
    }
  });

  test("rejects label filter with guidance", async () => {
    const result = await runDslEither("label:nsfw");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("not supported");
      expect(result.left.message).toContain("skygent filter help");
    }
  });

  test("rejects unknown has: value with valid options", async () => {
    const result = await runDslEither("has:gif");

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("images|video|links|media|embed");
    }
  });

  test("parses date range filter", async () => {
    const result = await runDsl("date:2024-01-01T00:00:00Z..2024-01-31T00:00:00Z");

    expect(result._tag).toBe("DateRange");
    if (result._tag === "DateRange") {
      expect(result.start.toISOString()).toBe("2024-01-01T00:00:00.000Z");
      expect(result.end.toISOString()).toBe("2024-01-31T00:00:00.000Z");
    }
  });

  test("parses links filter with default policy", async () => {
    const result = await runDsl("links");

    expect(result).toMatchObject({
      _tag: "HasValidLinks",
      onError: { _tag: "Exclude" }
    });
  });

  test("parses links filter with onError option", async () => {
    const result = await runDsl("links:onError=include");

    expect(result).toMatchObject({
      _tag: "HasValidLinks",
      onError: { _tag: "Include" }
    });
  });

  test("parses trending filter with onError override", async () => {
    const result = await runDsl("trending:#ai,onError=exclude");

    expect(result).toMatchObject({
      _tag: "Trending",
      tag: "#ai",
      onError: { _tag: "Exclude" }
    });
  });

  test("parses named filter references", async () => {
    const result = await runDsl("@tech", namedLibraryLayer);

    expect(result).toMatchObject({ _tag: "Hashtag", tag: "#tech" });
  });

  test("parses author lists", async () => {
    const result = await runDsl("authorin:alice.bsky.social,bob.bsky.social");

    expect(result).toMatchObject({
      _tag: "AuthorIn",
      handles: ["alice.bsky.social", "bob.bsky.social"]
    });
  });

  test("parses engagement options with key=value syntax", async () => {
    const result = await runDsl("engagement:minLikes=100,minReplies=5");

    expect(result).toMatchObject({
      _tag: "Engagement",
      minLikes: 100,
      minReplies: 5
    });
  });

  test("parses regex with spaces", async () => {
    const result = await runDsl("regex:/red card|yellow card/i");

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: ["red card|yellow card"],
      flags: "i"
    });
  });

  test("parses regex with parentheses", async () => {
    const result = await runDsl(String.raw`regex:/\b(Saka|Rice)\b/i`);

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: [String.raw`\b(Saka|Rice)\b`],
      flags: "i"
    });
  });

  test("parses regex with quantifier comma", async () => {
    const result = await runDsl("regex:/a{1,3}/");

    expect(result).toMatchObject({
      _tag: "Regex",
      patterns: ["a{1,3}"]
    });
  });

  test("parses since filter with relative duration", async () => {
    const result = await runDsl("since:24h");

    expect(result._tag).toBe("DateRange");
    if (result._tag === "DateRange") {
      expect(result.start.toISOString()).toBe("2026-01-30T00:00:00.000Z");
      expect(result.end.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    }
  });

  test("parses until filter with date-only input", async () => {
    const result = await runDsl("until:2026-01-15");

    expect(result._tag).toBe("DateRange");
    if (result._tag === "DateRange") {
      expect(result.start.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(result.end.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    }
  });

  test("parses age filter with comparator", async () => {
    const result = await runDsl("age:>24h");

    expect(result._tag).toBe("DateRange");
    if (result._tag === "DateRange") {
      expect(result.start.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(result.end.toISOString()).toBe("2026-01-30T00:00:00.000Z");
    }
  });
});

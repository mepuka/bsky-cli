import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";
import { FilterSpec } from "../../src/domain/store.js";
import { FilterCompiler } from "../../src/services/filter-compiler.js";

const decodeSpec = (input: unknown) => Schema.decodeUnknownSync(FilterSpec)(input);

describe("FilterCompiler", () => {
  test("compiles valid spec", async () => {
    const spec = decodeSpec({
      name: "tech",
      expr: { _tag: "Hashtag", tag: "#effect" },
      output: { path: "views/filters/tech", json: true, markdown: false }
    });

    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(FilterCompiler.layer)));
    expect(result._tag).toBe("Hashtag");
  });

  test("rejects invalid date range", async () => {
    const spec = decodeSpec({
      name: "range",
      expr: {
        _tag: "DateRange",
        start: "2026-01-02T00:00:00.000Z",
        end: "2026-01-01T00:00:00.000Z"
      },
      output: { path: "views/filters/range", json: true, markdown: false }
    });

    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(FilterCompiler.layer)))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("DateRange");
    }
  });

  test("rejects invalid retry policy", async () => {
    const spec = decodeSpec({
      name: "retry",
      expr: {
        _tag: "HasValidLinks",
        onError: { _tag: "Retry", maxRetries: 2, baseDelay: { _tag: "Infinity" } }
      },
      output: { path: "views/filters/retry", json: true, markdown: false }
    });

    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(FilterCompiler.layer)))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("finite");
    }
  });

  test("rejects invalid Llm confidence", async () => {
    const spec = {
      name: "llm",
      expr: {
        _tag: "Llm",
        prompt: "Is this relevant?",
        minConfidence: 1.5,
        onError: { _tag: "Include" }
      },
      output: { path: "views/filters/llm", json: true, markdown: false }
    };

    const result = await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(FilterSpec)(spec))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("between");
    }
  });

  test("rejects invalid regex", async () => {
    const spec = decodeSpec({
      name: "regex",
      expr: { _tag: "Regex", patterns: "[" },
      output: { path: "views/filters/regex", json: true, markdown: false }
    });

    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(FilterCompiler.layer)))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("Invalid regex");
    }
  });

  test("rejects engagement filter without thresholds", async () => {
    const spec = decodeSpec({
      name: "engagement",
      expr: { _tag: "Engagement" },
      output: { path: "views/filters/engagement", json: true, markdown: false }
    });

    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(FilterCompiler.layer)))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("Engagement");
    }
  });
});

import { describe, expect, test } from "bun:test";
import * as fc from "effect/FastCheck";
import * as Arbitrary from "effect/Arbitrary";
import { Effect, Layer, Schema } from "effect";
import { parseFilterDsl } from "../../src/cli/filter-dsl.js";
import { Handle, Hashtag } from "../../src/domain/primitives.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";

const handleArb = Arbitrary.make(Handle);
// Use a safe subset for DSL testing - avoids quotes and other DSL-special chars
const SafeHashtag = Schema.String.pipe(
  Schema.pattern(/^#[a-zA-Z][a-zA-Z0-9_]*$/),
  Schema.brand("Hashtag")
);
const hashtagArb = Arbitrary.make(SafeHashtag);
const timestampArb = fc.date({
  min: new Date("2026-01-01T00:00:00.000Z"),
  max: new Date("2026-12-31T23:59:59.000Z")
});

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

const toDate = (value: Date | string) =>
  typeof value === "string" ? new Date(value) : value;

describe("filter DSL property tests", () => {
  test("author DSL preserves handles", async () => {
    await fc.assert(
      fc.asyncProperty(handleArb, async (handle) => {
        const expr = await Effect.runPromise(
          parseFilterDsl(`author:${handle}`).pipe(Effect.provide(emptyLibraryLayer))
        );
        expect(expr).toMatchObject({ _tag: "Author", handle });
      }),
      { numRuns: 50 }
    );
  });

  test("hashtag DSL preserves tags", async () => {
    await fc.assert(
      fc.asyncProperty(hashtagArb, async (tag) => {
        const expr = await Effect.runPromise(
          parseFilterDsl(`hashtag:${tag}`).pipe(Effect.provide(emptyLibraryLayer))
        );
        expect(expr).toMatchObject({ _tag: "Hashtag", tag });
      }),
      { numRuns: 50 }
    );
  });

  test("date range DSL preserves ordering", async () => {
    await fc.assert(
      fc.asyncProperty(timestampArb, timestampArb, async (first, second) => {
        const start = toDate(first);
        const end = toDate(second);
        const [rangeStart, rangeEnd] =
          start.getTime() <= end.getTime() ? [start, end] : [end, start];

        const input = `date:${rangeStart.toISOString()}..${rangeEnd.toISOString()}`;
        const expr = await Effect.runPromise(
          parseFilterDsl(input).pipe(Effect.provide(emptyLibraryLayer))
        );

        expect(expr._tag).toBe("DateRange");
        if (expr._tag === "DateRange") {
          expect(expr.start.getTime()).toBe(rangeStart.getTime());
          expect(expr.end.getTime()).toBe(rangeEnd.getTime());
        }
      }),
      { numRuns: 50 }
    );
  });
});

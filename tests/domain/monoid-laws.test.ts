import { describe, expect, test } from "bun:test";
import * as fc from "effect/FastCheck";
import * as Arbitrary from "effect/Arbitrary";
import { Effect, Layer } from "effect";
import {
  FilterExprMonoid,
  Hashtag,
  Handle,
  Post,
  PostUri,
  Timestamp
} from "../../src/domain/index.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";
import { SyncError, SyncResult, SyncResultMonoid } from "../../src/domain/sync.js";
import type { FilterExpr } from "../../src/domain/filter.js";

const runtimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(LinkValidator.testLayer),
  Layer.provideMerge(TrendingTopics.testLayer)
);

const handleArb = Arbitrary.make(Handle);
const hashtagArb = Arbitrary.make(Hashtag);
const timestampArb = Arbitrary.make(Timestamp);
const postUriArb = Arbitrary.make(PostUri);
const postArb = fc
  .record({
    uri: postUriArb,
    author: handleArb,
    text: fc.string({ minLength: 1, maxLength: 200 }),
    createdAt: timestampArb,
    hashtags: fc.array(hashtagArb, { maxLength: 3 }),
    mentions: fc.array(handleArb, { maxLength: 3 }),
    links: fc.array(fc.webUrl().map((value) => new URL(value)), { maxLength: 3 })
  })
  .map((data) =>
    Post.make({
      uri: data.uri,
      author: data.author,
      text: data.text,
      createdAt: data.createdAt,
      hashtags: data.hashtags,
      mentions: data.mentions,
      links: data.links
    })
  );

const { expr: pureFilterArb } = fc.letrec((tie) => ({
  expr: fc.oneof(
    fc.constant({ _tag: "All" } as const),
    fc.constant({ _tag: "None" } as const),
    handleArb.map((handle) => ({ _tag: "Author", handle } as const)),
    hashtagArb.map((tag) => ({ _tag: "Hashtag", tag } as const)),
    fc.tuple(timestampArb, timestampArb)
      .filter(([a, b]) => a.getTime() !== b.getTime())
      .map(([a, b]) => {
        const [start, end] = a.getTime() < b.getTime() ? [a, b] : [b, a];
        return { _tag: "DateRange", start, end } as const;
      }),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]) => ({ _tag: "And", left, right } as const)),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]) => ({ _tag: "Or", left, right } as const)),
    tie("expr").map((expr) => ({ _tag: "Not", expr } as const))
  )
}));
const pureFilterExprArb = pureFilterArb as fc.Arbitrary<FilterExpr>;

const syncStageArb: fc.Arbitrary<SyncError["stage"]> = fc.constantFrom(
  "source",
  "parse",
  "filter",
  "store"
);
const syncErrorArb = fc
  .record({
    stage: syncStageArb,
    message: fc.string({ minLength: 1 }),
    cause: fc.option(fc.string(), { nil: undefined })
  })
  .map((data) => SyncError.make(data));

const syncResultArb = fc
  .record({
    postsAdded: fc.nat(1000),
    postsDeleted: fc.nat(1000),
    postsSkipped: fc.nat(1000),
    errors: fc.array(syncErrorArb, { maxLength: 5 })
  })
  .map((data) => SyncResult.make(data));

const evalFilter = (expr: FilterExpr, post: Post) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(post);
    }).pipe(Effect.provide(runtimeLayer))
  );

describe("Monoid laws", () => {
  test("FilterExprMonoid identity holds by evaluation", async () => {
    await fc.assert(
      fc.asyncProperty(pureFilterExprArb, postArb, async (expr, post) => {
        const left = await evalFilter(
          FilterExprMonoid.combine(FilterExprMonoid.empty, expr),
          post
        );
        const right = await evalFilter(expr, post);
        const rightIdentity = await evalFilter(
          FilterExprMonoid.combine(expr, FilterExprMonoid.empty),
          post
        );

        expect(left).toBe(right);
        expect(rightIdentity).toBe(right);
      }),
      { numRuns: 50 }
    );
  });

  test("FilterExprMonoid associativity holds by evaluation", async () => {
    await fc.assert(
      fc.asyncProperty(
        pureFilterExprArb,
        pureFilterExprArb,
        pureFilterExprArb,
        postArb,
        async (a, b, c, post) => {
        const left = await evalFilter(
          FilterExprMonoid.combine(a, FilterExprMonoid.combine(b, c)),
          post
        );
        const right = await evalFilter(
          FilterExprMonoid.combine(FilterExprMonoid.combine(a, b), c),
          post
        );

        expect(left).toBe(right);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("SyncResultMonoid identity holds", () => {
    fc.assert(
      fc.property(syncResultArb, (result) => {
        const left = SyncResultMonoid.combine(SyncResultMonoid.empty, result);
        const right = SyncResultMonoid.combine(result, SyncResultMonoid.empty);

        expect(left).toEqual(result);
        expect(right).toEqual(result);
      }),
      { numRuns: 100 }
    );
  });

  test("SyncResultMonoid associativity holds", () => {
    fc.assert(
      fc.property(syncResultArb, syncResultArb, syncResultArb, (a, b, c) => {
        const left = SyncResultMonoid.combine(a, SyncResultMonoid.combine(b, c));
        const right = SyncResultMonoid.combine(SyncResultMonoid.combine(a, b), c);

        expect(left).toEqual(right);
      }),
      { numRuns: 100 }
    );
  });
});

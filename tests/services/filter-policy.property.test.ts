import { describe, expect, test } from "bun:test";
import * as fc from "effect/FastCheck";
import * as Arbitrary from "effect/Arbitrary";
import { Duration, Effect, Layer } from "effect";
import type { FilterExpr } from "../../src/domain/filter.js";
import { FilterEvalError } from "../../src/domain/errors.js";
import {
  ExcludeOnError,
  IncludeOnError,
  RetryOnError
} from "../../src/domain/policies.js";
import { Post } from "../../src/domain/post.js";
import { Handle, Hashtag, PostUri, Timestamp } from "../../src/domain/primitives.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { FilterSettings } from "../../src/services/filter-settings.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";

const postUriArb = Arbitrary.make(PostUri);
const handleArb = Arbitrary.make(Handle);
const hashtagArb = Arbitrary.make(Hashtag);
const timestampArb = Arbitrary.make(Timestamp);
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

const policyArb = fc.oneof(
  fc.constant(IncludeOnError.make({})),
  fc.constant(ExcludeOnError.make({})),
  fc.record({ maxRetries: fc.nat(3) }).map(({ maxRetries }) =>
    RetryOnError.make({
      maxRetries,
      baseDelay: Duration.millis(0)
    })
  )
);

const failingLinkLayer = Layer.succeed(
  LinkValidator,
  LinkValidator.make({
    isValid: () =>
      Effect.fail(FilterEvalError.make({ message: "link failure" })),
    hasValidLink: () =>
      Effect.fail(FilterEvalError.make({ message: "link failure" }))
  })
);

const runtimeLayerForLinks = (linkLayer: Layer.Layer<never, never, LinkValidator>) =>
  FilterRuntime.layer.pipe(
    Layer.provideMerge(FilterSettings.layer),
    Layer.provideMerge(TrendingTopics.testLayer),
    Layer.provideMerge(linkLayer)
  );

describe("Filter error policy semantics", () => {
  test("HasValidLinks respects policy on failure", async () => {
    await fc.assert(
      fc.asyncProperty(policyArb, postArb, async (policy, post) => {
        const filter: FilterExpr = { _tag: "HasValidLinks", onError: policy };

        const program = Effect.gen(function* () {
          const runtime = yield* FilterRuntime;
          const predicate = yield* runtime.evaluate(filter);
          return yield* Effect.either(predicate(post));
        });

        const result = await Effect.runPromise(
          program.pipe(Effect.provide(runtimeLayerForLinks(failingLinkLayer)))
        );

        switch (policy._tag) {
          case "Include":
            expect(result._tag).toBe("Right");
            if (result._tag === "Right") {
              expect(result.right).toBe(true);
            }
            break;
          case "Exclude":
            expect(result._tag).toBe("Right");
            if (result._tag === "Right") {
              expect(result.right).toBe(false);
            }
            break;
          case "Retry":
            expect(result._tag).toBe("Left");
            break;
        }
      }),
      { numRuns: 30 }
    );
  });

  test("HasValidLinks does not alter successful results", async () => {
    await fc.assert(
      fc.asyncProperty(policyArb, fc.boolean(), postArb, async (policy, ok, post) => {
        const filter: FilterExpr = { _tag: "HasValidLinks", onError: policy };
        const successLayer = Layer.succeed(
          LinkValidator,
          LinkValidator.make({
            isValid: () => Effect.succeed(ok),
            hasValidLink: () => Effect.succeed(ok)
          })
        );

        const program = Effect.gen(function* () {
          const runtime = yield* FilterRuntime;
          const predicate = yield* runtime.evaluate(filter);
          return yield* predicate(post);
        });

        const result = await Effect.runPromise(
          program.pipe(Effect.provide(runtimeLayerForLinks(successLayer)))
        );

        expect(result).toBe(ok);
      }),
      { numRuns: 30 }
    );
  });
});

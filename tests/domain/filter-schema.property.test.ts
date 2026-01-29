import { describe, expect, test } from "bun:test";
import * as fc from "effect/FastCheck";
import * as Arbitrary from "effect/Arbitrary";
import { Duration, Schema } from "effect";
import type { FilterExpr } from "../../src/domain/filter.js";
import {
  encodeFilterExpr,
  FilterExprSchema,
  filterExprSignature
} from "../../src/domain/filter.js";
import {
  ExcludeOnError,
  IncludeOnError,
  RetryOnError
} from "../../src/domain/policies.js";
import { Handle, Hashtag, Timestamp } from "../../src/domain/primitives.js";

const handleArb = Arbitrary.make(Handle);
const hashtagArb = Arbitrary.make(Hashtag);
const timestampArb = Arbitrary.make(Timestamp).filter((value) =>
  Number.isFinite(value.getTime())
);
const languageArb = fc.constantFrom("en", "es", "fr", "de", "ja");

const regexPatternArb = fc.string({ minLength: 1, maxLength: 20 });
const regexFlagsArb = fc.option(
  fc.string({ minLength: 1, maxLength: 5 }),
  { nil: undefined }
);

const policyArb = fc.oneof(
  fc.constant(IncludeOnError.make({})),
  fc.constant(ExcludeOnError.make({})),
  fc
    .record({
      maxRetries: fc.nat(5),
      baseDelayMs: fc.nat(1000)
    })
    .map(({ maxRetries, baseDelayMs }) =>
      RetryOnError.make({
        maxRetries,
        baseDelay: Duration.millis(baseDelayMs)
      })
    )
);

const filterExprArb: fc.Arbitrary<FilterExpr> = fc.letrec((tie) => ({
  expr: fc.oneof(
    fc.constant({ _tag: "All" } as const),
    fc.constant({ _tag: "None" } as const),
    handleArb.map((handle) => ({ _tag: "Author", handle } as const)),
    hashtagArb.map((tag) => ({ _tag: "Hashtag", tag } as const)),
    fc
      .array(handleArb, { minLength: 1, maxLength: 3 })
      .map((handles) => ({ _tag: "AuthorIn", handles } as const)),
    fc
      .array(hashtagArb, { minLength: 1, maxLength: 3 })
      .map((tags) => ({ _tag: "HashtagIn", tags } as const)),
    fc
      .record({
        text: fc.string({ minLength: 1, maxLength: 50 }),
        caseSensitive: fc.option(fc.boolean(), { nil: undefined })
      })
      .map(({ text, caseSensitive }) =>
        caseSensitive === undefined
          ? ({ _tag: "Contains", text } as const)
          : ({ _tag: "Contains", text, caseSensitive } as const)
      ),
    fc.constant({ _tag: "IsReply" } as const),
    fc.constant({ _tag: "IsQuote" } as const),
    fc.constant({ _tag: "IsRepost" } as const),
    fc.constant({ _tag: "IsOriginal" } as const),
    fc
      .record({
        minLikes: fc.option(fc.nat(1000), { nil: undefined }),
        minReposts: fc.option(fc.nat(1000), { nil: undefined }),
        minReplies: fc.option(fc.nat(1000), { nil: undefined })
      })
      .filter(
        (values) =>
          values.minLikes !== undefined ||
          values.minReposts !== undefined ||
          values.minReplies !== undefined
      )
      .map(({ minLikes, minReposts, minReplies }) => ({
        _tag: "Engagement",
        ...(minLikes !== undefined ? { minLikes } : {}),
        ...(minReposts !== undefined ? { minReposts } : {}),
        ...(minReplies !== undefined ? { minReplies } : {})
      })),
    fc.constant({ _tag: "HasImages" } as const),
    fc.constant({ _tag: "HasVideo" } as const),
    fc.constant({ _tag: "HasLinks" } as const),
    fc.constant({ _tag: "HasMedia" } as const),
    fc
      .array(languageArb, { minLength: 1, maxLength: 3 })
      .map((langs) => ({ _tag: "Language", langs } as const)),
    fc
      .tuple(fc.array(regexPatternArb, { minLength: 1, maxLength: 3 }), regexFlagsArb)
      .map(([patterns, flags]) =>
        flags
          ? ({ _tag: "Regex", patterns, flags } as const)
          : ({ _tag: "Regex", patterns } as const)
      ),
    fc.tuple(timestampArb, timestampArb)
      .filter(([a, b]) => a.getTime() !== b.getTime())
      .map(([a, b]) => {
        const [start, end] = a.getTime() < b.getTime() ? [a, b] : [b, a];
        return { _tag: "DateRange", start, end } as const;
      }),
    policyArb.map((onError) => ({ _tag: "HasValidLinks", onError } as const)),
    fc
      .tuple(hashtagArb, policyArb)
      .map(([tag, onError]) => ({ _tag: "Trending", tag, onError } as const)),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]) => ({ _tag: "And", left, right } as const)),
    fc
      .tuple(tie("expr"), tie("expr"))
      .map(([left, right]) => ({ _tag: "Or", left, right } as const)),
    tie("expr").map((expr) => ({ _tag: "Not", expr } as const))
  )
})).expr as fc.Arbitrary<FilterExpr>;

describe("FilterExpr schema", () => {
  test("encode/decode preserves signature", () => {
    fc.assert(
      fc.property(filterExprArb, (expr) => {
        const encoded = encodeFilterExpr(expr);
        const decoded = Schema.decodeUnknownSync(FilterExprSchema)(encoded);
        expect(filterExprSignature(decoded)).toBe(filterExprSignature(expr));
      }),
      { numRuns: 100 }
    );
  });
});

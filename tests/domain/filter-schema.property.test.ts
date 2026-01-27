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
const timestampArb = Arbitrary.make(Timestamp);

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
      .tuple(fc.array(regexPatternArb, { minLength: 1, maxLength: 3 }), regexFlagsArb)
      .map(([patterns, flags]) =>
        flags
          ? ({ _tag: "Regex", patterns, flags } as const)
          : ({ _tag: "Regex", patterns } as const)
      ),
    fc.tuple(timestampArb, timestampArb).map(([start, end]) => ({
      _tag: "DateRange",
      start,
      end
    })),
    policyArb.map((onError) => ({ _tag: "HasValidLinks", onError } as const)),
    fc
      .tuple(hashtagArb, policyArb)
      .map(([tag, onError]) => ({ _tag: "Trending", tag, onError } as const)),
    fc
      .record({
        prompt: fc.string({ minLength: 1, maxLength: 100 }),
        minConfidence: fc.float({
          min: 0,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true
        }),
        onError: policyArb
      })
      .map(({ prompt, minConfidence, onError }) => ({
        _tag: "Llm",
        prompt,
        minConfidence,
        onError
      } as const)),
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

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { FilterExprSchema } from "../../src/domain/filter.js";
import { FilterErrorPolicy } from "../../src/domain/policies.js";

describe("FilterExpr", () => {
  test("decodes tagged union values", () => {
    const decoded = Schema.decodeUnknownSync(FilterExprSchema)({
      _tag: "Hashtag",
      tag: "#effect"
    });
    expect(decoded._tag).toBe("Hashtag");
  });

  test("decodes regex filter with single pattern", () => {
    const decoded = Schema.decodeUnknownSync(FilterExprSchema)({
      _tag: "Regex",
      patterns: "hello"
    });
    expect(decoded._tag).toBe("Regex");
    if (decoded._tag === "Regex") {
      expect(decoded.patterns).toEqual(["hello"]);
    }
  });

  test("decodes regex filter with array of patterns", () => {
    const decoded = Schema.decodeUnknownSync(FilterExprSchema)({
      _tag: "Regex",
      patterns: ["hello", "#effect"],
      flags: "i"
    });
    expect(decoded._tag).toBe("Regex");
    if (decoded._tag === "Regex") {
      expect(decoded.patterns).toEqual(["hello", "#effect"]);
    }
  });
});

describe("FilterDateRange validation", () => {
  test("accepts start before end", () => {
    const decoded = Schema.decodeUnknownSync(FilterExprSchema)({
      _tag: "DateRange",
      start: "2024-01-01T00:00:00Z",
      end: "2024-12-31T00:00:00Z"
    });
    expect(decoded._tag).toBe("DateRange");
  });

  test("rejects start after end", () => {
    expect(() =>
      Schema.decodeUnknownSync(FilterExprSchema)({
        _tag: "DateRange",
        start: "2024-12-31T00:00:00Z",
        end: "2024-01-01T00:00:00Z"
      })
    ).toThrow(/start.*before.*end/i);
  });

  test("rejects start equal to end", () => {
    expect(() =>
      Schema.decodeUnknownSync(FilterExprSchema)({
        _tag: "DateRange",
        start: "2024-06-15T00:00:00Z",
        end: "2024-06-15T00:00:00Z"
      })
    ).toThrow(/start.*before.*end/i);
  });
});

describe("FilterErrorPolicy", () => {
  test("decodes retry policy", () => {
    const decoded = Schema.decodeUnknownSync(
      FilterErrorPolicy as Schema.Schema<FilterErrorPolicy, unknown, never>
    )({
      _tag: "Retry",
      maxRetries: 3,
      baseDelay: { _tag: "Millis", millis: 1000 }
    });
    expect(decoded._tag).toBe("Retry");
  });
});

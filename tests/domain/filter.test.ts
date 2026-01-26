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

  test("decodes LLM filter with policy", () => {
    const decoded = Schema.decodeUnknownSync(FilterExprSchema)({
      _tag: "Llm",
      prompt: "Is this relevant?",
      minConfidence: 0.7,
      onError: { _tag: "Include" }
    });
    expect(decoded._tag).toBe("Llm");
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

import { describe, expect, test } from "bun:test";
import { Effect, ParseResult, Schema } from "effect";
import { formatParseError } from "../../src/services/shared.js";
import { issueDetails } from "../../src/cli/parse-errors.js";
import { formatFilterParseError } from "../../src/cli/filter-errors.js";
import { formatStoreConfigParseError } from "../../src/cli/store-errors.js";
import { FilterExprSchema } from "../../src/domain/filter.js";
import { StoreConfig } from "../../src/domain/store.js";

const getParseError = async <A>(schema: Schema.Schema<A>, input: unknown) => {
  const result = await Effect.runPromise(
    Schema.decodeUnknown(schema)(input).pipe(Effect.either)
  );
  if (result._tag === "Right") {
    throw new Error("Expected parse error");
  }
  if (!ParseResult.isParseError(result.left)) {
    throw new Error("Expected ParseError");
  }
  return result.left;
};

describe("parse error formatting", () => {
  test("issueDetails formats dotted paths", () => {
    const details = issueDetails([
      { path: ["filters", 0, "name"], message: "is missing" }
    ]);
    expect(details).toEqual(["filters.0.name: is missing"]);
  });

  test("formatParseError emits JSON tip for parse errors", async () => {
    const schema = Schema.parseJson(Schema.Struct({ foo: Schema.Number }));
    const error = await getParseError(schema, "{");
    const message = formatParseError(error, { label: "filter JSON" });

    expect(message).toContain("Invalid JSON input for filter JSON.");
    expect(message).toContain("JSON Parse error");
    expect(message).toContain("Tip: wrap JSON in single quotes");
  });

  test("formatParseError caps issue output", async () => {
    const missing = new ParseResult.Missing(Schema.String.ast);
    const issues = ["a", "b", "c", "d", "e", "f", "g"].map(
      (key) => new ParseResult.Pointer([key], undefined, missing)
    );
    const composite = new ParseResult.Composite(
      Schema.Struct({}).ast,
      {},
      issues as [ParseResult.ParseIssue, ...ParseResult.ParseIssue[]]
    );
    const error = ParseResult.parseError(composite);
    const message = formatParseError(error, { label: "payload", maxIssues: 3 });

    expect(message).toContain("Invalid payload.");
    expect(message).toContain("Additional issues: 4");
  });

  test("formatFilterParseError handles missing _tag", async () => {
    const raw = JSON.stringify({ tag: "#ai" });
    const error = await getParseError(
      Schema.parseJson(FilterExprSchema),
      raw
    );
    const message = formatFilterParseError(error, raw);
    const payload = JSON.parse(message) as { error: string; message: string; validTags?: string[] };

    expect(payload.error).toBe("FilterValidationError");
    expect(payload.message).toContain("requires a _tag field");
    expect(payload.validTags?.length).toBeGreaterThan(0);
  });

  test("formatFilterParseError handles JSON parse failures", async () => {
    const raw = "{";
    const error = await getParseError(
      Schema.parseJson(FilterExprSchema),
      raw
    );
    const message = formatFilterParseError(error, raw);
    const payload = JSON.parse(message) as { error: string; details?: string[] };

    expect(payload.error).toBe("FilterJsonParseError");
    expect(payload.details).toEqual(
      expect.arrayContaining(["Tip: wrap JSON in single quotes to avoid shell escaping issues."])
    );
  });

  test("formatStoreConfigParseError handles missing filters", async () => {
    const raw = JSON.stringify({ format: { json: true, markdown: false }, autoSync: false });
    const error = await getParseError(
      Schema.parseJson(StoreConfig),
      raw
    );
    const message = formatStoreConfigParseError(error, raw);
    const payload = JSON.parse(message) as { error: string; message: string };

    expect(payload.error).toBe("StoreConfigValidationError");
    expect(payload.message).toContain("requires a filters array");
  });

  test("formatStoreConfigParseError handles JSON parse failures", async () => {
    const raw = "{";
    const error = await getParseError(
      Schema.parseJson(StoreConfig),
      raw
    );
    const message = formatStoreConfigParseError(error, raw);
    const payload = JSON.parse(message) as { error: string; details?: string[] };

    expect(payload.error).toBe("StoreConfigJsonParseError");
    expect(payload.details).toEqual(
      expect.arrayContaining(["Tip: wrap JSON in single quotes to avoid shell escaping issues."])
    );
  });
});

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { formatFilterParseError } from "../../src/cli/filter-errors.js";
import { decodeJson } from "../../src/cli/parse.js";
import { FilterExprSchema } from "../../src/domain/filter.js";

const parseFilterJson = (raw: string) =>
  decodeJson(FilterExprSchema, raw, { formatter: formatFilterParseError }).pipe(
    Effect.either
  );

describe("filter JSON error formatting", () => {
  test("formats missing regex patterns with agent-friendly payload", async () => {
    const raw = "{\"_tag\":\"Regex\",\"pattern\":\"[Tt]rump\"}";
    const result = await Effect.runPromise(parseFilterJson(raw));
    if (result._tag === "Right") {
      throw new Error("Expected parse failure");
    }

    const payload = JSON.parse(result.left.message) as {
      error: string;
      received?: Record<string, unknown>;
      expected?: Record<string, unknown>;
      fix?: string;
      details?: ReadonlyArray<string>;
    };

    expect(payload.error).toBe("FilterValidationError");
    expect(payload.received?._tag).toBe("Regex");
    expect(payload.expected?._tag).toBe("Regex");
    expect(payload.fix ?? "").toContain("patterns");
    expect(payload.details?.join(" ")).toContain("skygent filter help");
  });

  test("formats invalid JSON with agent-friendly payload", async () => {
    const raw = "{";
    const result = await Effect.runPromise(parseFilterJson(raw));
    if (result._tag === "Right") {
      throw new Error("Expected parse failure");
    }

    const payload = JSON.parse(result.left.message) as {
      error: string;
      message: string;
      received?: unknown;
      details?: ReadonlyArray<string>;
    };

    expect(payload.error).toBe("FilterJsonParseError");
    expect(payload.message).toContain("Invalid JSON");
    expect(payload.received).toBe(raw);
    expect(payload.details?.join(" ")).toContain("skygent filter help");
  });
});

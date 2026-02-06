import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { resolveOutputFormat } from "../../src/cli/output-format.js";

describe("resolveOutputFormat", () => {
  test("prefers explicit format over config", () => {
    const result = resolveOutputFormat(
      Option.some("json"),
      "table" as const,
      ["json", "table"] as const,
      "json"
    );
    expect(result).toBe("json");
  });

  test("uses config format when supported", () => {
    const result = resolveOutputFormat(
      Option.none(),
      "table" as const,
      ["json", "table"] as const,
      "json"
    );
    expect(result).toBe("table");
  });

  test("falls back when config format unsupported", () => {
    const result = resolveOutputFormat(
      Option.none(),
      "markdown" as const,
      ["json", "table"] as const,
      "json"
    );
    expect(result).toBe("json");
  });
});

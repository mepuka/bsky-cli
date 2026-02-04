import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { resolveOutputFormat } from "../../src/cli/output-format.js";

const withEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.SKYGENT_OUTPUT_FORMAT;
  if (value === undefined) {
    delete process.env.SKYGENT_OUTPUT_FORMAT;
  } else {
    process.env.SKYGENT_OUTPUT_FORMAT = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.SKYGENT_OUTPUT_FORMAT;
    } else {
      process.env.SKYGENT_OUTPUT_FORMAT = previous;
    }
  }
};

describe("resolveOutputFormat", () => {
  test("prefers explicit format over env and config", () => {
    withEnv("table", () => {
      const result = resolveOutputFormat(
        Option.some("json"),
        "markdown" as const,
        ["json", "table"] as const,
        "json"
      );
      expect(result).toBe("json");
    });
  });

  test("uses env format when supported", () => {
    withEnv("table", () => {
      const result = resolveOutputFormat(
        Option.none(),
        "markdown" as const,
        ["json", "table"] as const,
        "json"
      );
      expect(result).toBe("table");
    });
  });

  test("falls back to config when env format unsupported", () => {
    withEnv("markdown", () => {
      const result = resolveOutputFormat(
        Option.none(),
        "table" as const,
        ["json", "table"] as const,
        "json"
      );
      expect(result).toBe("table");
    });
  });
});

import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { parseRange } from "../../src/cli/range.js";

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

describe("parseRange", () => {
  test("parses valid ISO range", async () => {
    const result = await run(
      parseRange("2026-01-01T00:00:00Z..2026-01-02T00:00:00Z")
    );
    expect(result.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result.end.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  test("rejects missing end", async () => {
    const result = await run(Effect.either(parseRange("2026-01-01T00:00:00Z..")));
    expect(Either.isLeft(result)).toBe(true);
  });

  test("rejects start after end", async () => {
    const result = await run(
      Effect.either(parseRange("2026-01-02T00:00:00Z..2026-01-01T00:00:00Z"))
    );
    expect(Either.isLeft(result)).toBe(true);
  });
});

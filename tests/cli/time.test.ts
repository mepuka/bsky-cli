import { describe, expect, test } from "bun:test";
import { Duration, Effect, Either } from "effect";
import { parseDurationInput, parseTimeInput } from "../../src/cli/time.js";

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

describe("parseDurationInput", () => {
  test("parses compact duration", async () => {
    const duration = await run(parseDurationInput("1.5h"));
    expect(Duration.toMillis(duration)).toBe(5_400_000);
  });

  test("rejects negative duration", async () => {
    const result = await run(Effect.either(parseDurationInput("-1h")));
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("parseTimeInput", () => {
  test("parses relative duration from now", async () => {
    const now = new Date("2026-01-31T12:00:00.000Z");
    const parsed = await run(parseTimeInput("24h", now));
    expect(parsed.toISOString()).toBe("2026-01-30T12:00:00.000Z");
  });

  test("rejects timestamp without timezone", async () => {
    const now = new Date("2026-01-31T12:00:00.000Z");
    const result = await run(Effect.either(parseTimeInput("2026-01-31T12:00:00", now)));
    expect(Either.isLeft(result)).toBe(true);
  });
});

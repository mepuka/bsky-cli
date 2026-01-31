import { describe, expect, test } from "bun:test";
import { Duration, Effect, Either, Option, Schema } from "effect";
import { parseInterval } from "../../src/cli/interval.js";
import { DurationInput } from "../../src/cli/option-schemas.js";

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

describe("parseInterval", () => {
  test("defaults to 30 seconds", async () => {
    const interval = parseInterval(Option.none());
    expect(Duration.toMillis(interval)).toBe(30000);
  });

  test("parses textual duration", async () => {
    const parsed = await run(Schema.decodeUnknown(DurationInput)("45 seconds"));
    const interval = parseInterval(Option.some(parsed));
    expect(Duration.toMillis(interval)).toBe(45000);
  });

  test("rejects invalid text", async () => {
    const result = await run(
      Effect.either(Schema.decodeUnknown(DurationInput)("not-a-duration"))
    );
    expect(Either.isLeft(result)).toBe(true);
  });

});

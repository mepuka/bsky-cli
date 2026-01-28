import { describe, expect, test } from "bun:test";
import { Duration, Effect, Either, Option } from "effect";
import { parseInterval } from "../../src/cli/interval.js";
import { CliInputError } from "../../src/cli/errors.js";

const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);

describe("parseInterval", () => {
  test("defaults to 30 seconds", async () => {
    const interval = await run(parseInterval(Option.none()));
    expect(Duration.toMillis(interval)).toBe(30000);
  });

  test("parses textual duration", async () => {
    const interval = await run(parseInterval(Option.some("45 seconds")));
    expect(Duration.toMillis(interval)).toBe(45000);
  });

  test("rejects invalid text", async () => {
    const result = await run(
      Effect.either(parseInterval(Option.some("not-a-duration")))
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(CliInputError);
    }
  });

});

import { describe, expect, test } from "bun:test";
import { Effect, Option, Schema } from "effect";
import { resolveStoreName } from "../../src/cli/shared-options.js";
import { StoreName } from "../../src/domain/primitives.js";

const storeAlpha = Schema.decodeUnknownSync(StoreName)("alpha");
const storeBravo = Schema.decodeUnknownSync(StoreName)("bravo");

describe("resolveStoreName", () => {
  test("uses positional store when --store is omitted", async () => {
    const result = await Effect.runPromise(
      resolveStoreName(Option.some(storeAlpha), Option.none())
    );
    expect(result).toBe(storeAlpha);
  });

  test("uses --store when positional is omitted", async () => {
    const result = await Effect.runPromise(
      resolveStoreName(Option.none(), Option.some(storeAlpha))
    );
    expect(result).toBe(storeAlpha);
  });

  test("fails when both positional and --store are provided", async () => {
    const result = await Effect.runPromise(
      resolveStoreName(Option.some(storeAlpha), Option.some(storeBravo)).pipe(Effect.either)
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CliInputError");
      expect(result.left.message).toContain("positional");
    }
  });

  test("fails when neither positional nor --store are provided", async () => {
    const result = await Effect.runPromise(
      resolveStoreName(Option.none(), Option.none()).pipe(Effect.either)
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CliInputError");
      expect(result.left.message).toContain("store name");
    }
  });
});

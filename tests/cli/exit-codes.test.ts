import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { exitCodeFor, exitCodeFromExit } from "../../src/cli/exit-codes.js";
import { CliJsonError } from "../../src/cli/errors.js";
import { StoreNotFound } from "../../src/domain/errors.js";
import { StoreName } from "../../src/domain/primitives.js";
import { SyncError } from "../../src/domain/sync.js";

describe("exit codes", () => {
  test("exitCodeFor maps domain errors", () => {
    const name = Schema.decodeUnknownSync(StoreName)("missing-store");
    expect(exitCodeFor(StoreNotFound.make({ name }))).toBe(3);
    expect(
      exitCodeFor(
        SyncError.make({
          stage: "source",
          message: "boom",
          cause: "fail"
        })
      )
    ).toBe(5);
    expect(exitCodeFor(CliJsonError.make({ message: "bad", cause: "x" }))).toBe(2);
  });

  test("exitCodeFromExit maps failures", async () => {
    const name = Schema.decodeUnknownSync(StoreName)("missing-store");
    const exit = await Effect.runPromise(
      Effect.exit(Effect.fail(StoreNotFound.make({ name })))
    );
    expect(exitCodeFromExit(exit)).toBe(3);
  });
});

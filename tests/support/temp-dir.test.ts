import { describe, expect, test } from "bun:test";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect } from "effect";
import { makeTempDir, removeTempDir, withTempDir } from "./temp-dir.js";

describe("temp-dir support", () => {
  test("makeTempDir creates a directory and removeTempDir removes it", async () => {
    const path = await makeTempDir();

    const existsBefore = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(path);
      }).pipe(Effect.provide(BunContext.layer))
    );
    expect(existsBefore).toBe(true);

    await removeTempDir(path);

    const existsAfter = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(path);
      }).pipe(Effect.provide(BunContext.layer))
    );
    expect(existsAfter).toBe(false);
  });

  test("withTempDir cleans up after callback", async () => {
    let createdPath = "";

    await withTempDir(async (path) => {
      createdPath = path;
      const exists = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(path);
        }).pipe(Effect.provide(BunContext.layer))
      );
      expect(exists).toBe(true);
    });

    const existsAfter = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.exists(createdPath);
      }).pipe(Effect.provide(BunContext.layer))
    );
    expect(existsAfter).toBe(false);
  });
});

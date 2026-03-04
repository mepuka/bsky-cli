import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect } from "effect";

export function makeTempDir() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory();
    }).pipe(Effect.provide(BunContext.layer))
  );
}

export function removeTempDir(path: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true });
    }).pipe(Effect.provide(BunContext.layer))
  );
}

export const withTempDir = async <A>(
  fn: (path: string) => Promise<A> | A
): Promise<A> => {
  const path = await makeTempDir();
  try {
    return await fn(path);
  } finally {
    await removeTempDir(path);
  }
};

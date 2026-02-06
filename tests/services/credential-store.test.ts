import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import {
  CredentialStore,
  CredentialsOverrides,
  type CredentialsOverridesValue
} from "../../src/services/credential-store.js";
import { BskyCredentials } from "../../src/domain/credentials.js";

const envProvider = (entries: Array<readonly [string, string]>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(entries)));

const makeTempDir = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory();
    }).pipe(Effect.provide(BunContext.layer))
  );

const removeTempDir = (path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true });
    }).pipe(Effect.provide(BunContext.layer))
  );

const buildLayer = (
  storeRoot: string,
  envEntries: Array<readonly [string, string]>,
  overrides?: CredentialsOverridesValue
) => {
  const envLayer = envProvider(envEntries);
  const overridesLayer = overrides
    ? Layer.succeed(CredentialsOverrides, CredentialsOverrides.make(overrides))
    : CredentialsOverrides.layer;
  const baseLayer = Layer.mergeAll(
    BunContext.layer,
    envLayer,
    overridesLayer,
    Layer.succeed(ConfigOverrides, { storeRoot })
  );
  const appLayer = AppConfigService.layer.pipe(Layer.provideMerge(baseLayer));
  const credentialLayer = CredentialStore.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(baseLayer, appLayer))
  );

  return Layer.mergeAll(baseLayer, appLayer, credentialLayer);
};

describe("CredentialStore", () => {
  test("uses keyfile when env key is missing", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir, []);
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "alice.bsky.social",
              password: Redacted.make("app-password")
            })
          );
          const creds = yield* store.get();
          const status = yield* store.status();
          return { creds, status };
        }).pipe(Effect.provide(layer))
      );

      expect(Option.isSome(result.creds)).toBe(true);
      expect(result.status.keySource).toBe("file");
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("wrong env key results in no credentials (tolerant file load)", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, []);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "alice.bsky.social",
              password: Redacted.make("app-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      const readLayer = buildLayer(tempDir, [
        ["SKYGENT_CREDENTIALS_KEY", "different-key"]
      ]);

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("overrides take priority over file", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, []);
    try {
      // Save credentials with a keyfile
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "file.bsky.social",
              password: Redacted.make("file-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      // Read with overrides — should return overrides, not file
      const readLayer = buildLayer(tempDir, [], {
        identifier: "override.bsky.social",
        password: Redacted.make("override-password")
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.identifier).toBe("override.bsky.social");
        expect(Redacted.value(result.value.password)).toBe("override-password");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("env vars take priority over file", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, []);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "file.bsky.social",
              password: Redacted.make("file-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      const readLayer = buildLayer(tempDir, [
        ["SKYGENT_IDENTIFIER", "env.bsky.social"],
        ["SKYGENT_PASSWORD", "env-password"]
      ]);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.identifier).toBe("env.bsky.social");
        expect(Redacted.value(result.value.password)).toBe("env-password");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("tolerates corrupt file when overrides present", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, []);
    try {
      // Save credentials, then we'll read with wrong key + overrides
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "file.bsky.social",
              password: Redacted.make("file-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      // Read with wrong key but with overrides — overrides win
      const readLayer = buildLayer(
        tempDir,
        [["SKYGENT_CREDENTIALS_KEY", "wrong-key"]],
        {
          identifier: "override.bsky.social",
          password: Redacted.make("override-password")
        }
      );
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.identifier).toBe("override.bsky.social");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("tolerates corrupt file when env vars present", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, []);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.setKey();
          yield* store.save(
            BskyCredentials.make({
              identifier: "file.bsky.social",
              password: Redacted.make("file-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      // Read with wrong key but with env vars — env wins
      const readLayer = buildLayer(tempDir, [
        ["SKYGENT_CREDENTIALS_KEY", "wrong-key"],
        ["SKYGENT_IDENTIFIER", "env.bsky.social"],
        ["SKYGENT_PASSWORD", "env-password"]
      ]);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.identifier).toBe("env.bsky.social");
        expect(Redacted.value(result.value.password)).toBe("env-password");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("missing key returns none when credentials file exists (tolerant)", async () => {
    const tempDir = await makeTempDir();
    const writeLayer = buildLayer(tempDir, [
      ["SKYGENT_CREDENTIALS_KEY", "base-key"]
    ]);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.save(
            BskyCredentials.make({
              identifier: "alice.bsky.social",
              password: Redacted.make("app-password")
            })
          );
        }).pipe(Effect.provide(writeLayer))
      );

      const readLayer = buildLayer(tempDir, []);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* CredentialStore;
          return yield* store.get();
        }).pipe(Effect.provide(readLayer))
      );

      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import {
  CredentialStore,
  CredentialsOverrides
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

const buildLayer = (storeRoot: string, envEntries: Array<readonly [string, string]>) => {
  const envLayer = envProvider(envEntries);
  const baseLayer = Layer.mergeAll(
    BunContext.layer,
    envLayer,
    CredentialsOverrides.layer,
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

  test("env key overrides keyfile", async () => {
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
        Effect.either(
          Effect.gen(function* () {
            const store = yield* CredentialStore;
            return yield* store.get();
          }).pipe(Effect.provide(readLayer))
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("decrypt");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("missing key errors when credentials file exists", async () => {
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
        Effect.either(
          Effect.gen(function* () {
            const store = yield* CredentialStore;
            return yield* store.get();
          }).pipe(Effect.provide(readLayer))
        )
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left.message).toContain("no credentials key");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";

const FileConfigSchema = Schema.Struct({
  service: Schema.String,
  outputFormat: Schema.Literal("json", "ndjson", "markdown", "table"),
  storeRoot: Schema.String
});
const FileConfigJson = Schema.parseJson(FileConfigSchema);

const envProvider = (entries: Array<readonly [string, string]>) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map(entries))
  );

describe("AppConfigService", () => {
  test("respects CLI > env > file > defaults", async () => {
    const originalHome = process.env.HOME;

    const home = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );
    process.env.HOME = home;

    const expectedStoreRoot = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = path.join(home, ".skygent");
        const configPath = path.join(configDir, "config.json");
        yield* fs.makeDirectory(configDir, { recursive: true });
        const fileConfigJson = yield* Schema.encode(FileConfigJson)({
          service: "https://file.example",
          outputFormat: "markdown",
          storeRoot: "file-root"
        });
        yield* fs.writeFileString(configPath, fileConfigJson);
        return path.join(home, "override-root");
      }).pipe(Effect.provide(BunContext.layer))
    );

    const overridesLayer = Layer.succeed(ConfigOverrides, {
      outputFormat: "table",
      storeRoot: "~/override-root"
    });
    const appLayer = AppConfigService.layer.pipe(
      Layer.provide(overridesLayer),
      Layer.provide(BunContext.layer),
      Layer.provide(
        envProvider([
          ["SKYGENT_SERVICE", "https://env.example"],
          ["SKYGENT_OUTPUT_FORMAT", "json"],
          ["SKYGENT_STORE_ROOT", "env-root"]
        ])
      )
    );

    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          const resolved = yield* AppConfigService;
          return resolved;
        }).pipe(Effect.provide(appLayer))
      );
      expect(config.service).toBe("https://env.example");
      expect(config.outputFormat).toBe("table");
      expect(config.storeRoot).toBe(expectedStoreRoot);
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(home, { recursive: true });
        }).pipe(Effect.provide(BunContext.layer))
      );
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { logErrorEvent } from "../../src/cli/logging.js";
import { storeCommand } from "../../src/cli/store.js";
import { LineageStore } from "../../src/services/lineage-store.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreCleaner } from "../../src/services/store-cleaner.js";
import { CliPreferences } from "../../src/cli/preferences.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { FileSystem } from "@effect/platform";
import {
  makeOutputCapture,
  readStderr,
  readStdout
} from "../support/cli-output-capture.js";

describe("CLI store command", () => {
  test("writes JSON to stdout and keeps stderr clean", async () => {
    const run = Command.run(storeCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const { layer, stdoutRef, stderrRef } = makeOutputCapture();
    const storeRoot = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );
    const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provide(overrides),
      Layer.provide(BunContext.layer)
    );
    const storeLayer = Layer.mergeAll(
      StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer)),
      LineageStore.layer
    ).pipe(Layer.provide(KeyValueStore.layerMemory));
    const cleanerLayer = Layer.succeed(
      StoreCleaner,
      StoreCleaner.make({
        deleteStore: () => Effect.succeed({ deleted: false } as const)
      })
    );
    const preferencesLayer = Layer.succeed(CliPreferences, { compact: false });
    const appLayer = Layer.mergeAll(
      layer,
      storeLayer,
      cleanerLayer,
      preferencesLayer
    ).pipe(Layer.provideMerge(BunContext.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* run(["node", "skygent", "list"]);
        yield* run(["node", "skygent", "create", "demo"]);
        yield* run(["node", "skygent", "show", "demo"]);
      }).pipe(Effect.provide(appLayer))
    );

    const stdout = await readStdout(stdoutRef);
    const stderr = await readStderr(stderrRef);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(storeRoot, { recursive: true });
      }).pipe(Effect.provide(BunContext.layer))
    );

    expect(stderr.length).toBe(0);

    const payloads = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    expect(payloads[0]).toEqual([]);
    expect(payloads[1]).toMatchObject({ name: "demo" });
    expect(payloads[2]).toMatchObject({ store: { name: "demo" } });
  });
});

describe("CLI logging", () => {
  test("writes structured errors to stderr", async () => {
    const { layer, stderrRef } = makeOutputCapture();

    await Effect.runPromise(
      logErrorEvent("boom", { code: 123 }).pipe(Effect.provide(layer))
    );

    const stderr = await readStderr(stderrRef);
    const lines = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    const first = lines[0];
    if (!first) {
      throw new Error("Expected stderr output");
    }
    const payload = JSON.parse(first);
    expect(payload.level).toBe("ERROR");
    expect(payload.message).toBe("boom");
    expect(payload.code).toBe(123);
  });
});

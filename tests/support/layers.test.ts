import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { AppConfigService } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreName } from "../../src/domain/primitives.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { makeOutputCapture } from "./cli-output-capture.js";
import { buildAppConfigLayer, buildCliTestLayer, buildStoreCoreLayer } from "./layers.js";
import { makeTempDir, removeTempDir } from "./temp-dir.js";

describe("layers support", () => {
  test("buildAppConfigLayer applies storeRoot override", async () => {
    const storeRoot = await makeTempDir();
    try {
      const config = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* AppConfigService;
        }).pipe(Effect.provide(buildAppConfigLayer(storeRoot)))
      );
      expect(config.storeRoot).toBe(storeRoot);
    } finally {
      await removeTempDir(storeRoot);
    }
  });

  test("buildStoreCoreLayer provides store manager and index dependencies", async () => {
    const storeRoot = await makeTempDir();
    try {
      const store = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          return yield* manager.createStore(
            StoreName.make("support-test-store"),
            defaultStoreConfig
          );
        }).pipe(Effect.provide(buildStoreCoreLayer(storeRoot)))
      );
      expect(store.name).toBe("support-test-store");
    } finally {
      await removeTempDir(storeRoot);
    }
  });

  test("buildCliTestLayer merges output layer, core layers, and extras", async () => {
    const storeRoot = await makeTempDir();
    try {
      const output = makeOutputCapture();
      const extra = Layer.empty;
      const appLayer = buildCliTestLayer({
        storeRoot,
        outputLayer: output.layer,
        extraLayers: [extra]
      });

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const store = yield* manager.createStore(
            StoreName.make("cli-layer-store"),
            defaultStoreConfig
          );
          return store.name;
        }).pipe(Effect.provide(appLayer))
      );

      expect(result).toBe("cli-layer-store");
    } finally {
      await removeTempDir(storeRoot);
    }
  });
});

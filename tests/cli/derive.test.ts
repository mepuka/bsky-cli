import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Ref, Schema, Sink, Stream } from "effect";
import { deriveCommand } from "../../src/cli/derive.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { DerivationResult } from "../../src/domain/derivation.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { StoreName } from "../../src/domain/primitives.js";
import { OutputManager } from "../../src/services/output-manager.js";
import { DerivationEngine } from "../../src/services/derivation-engine.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { StoreLock } from "../../src/services/store-lock.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { CliPreferences } from "../../src/cli/preferences.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { BunContext } from "@effect/platform-bun";
import { FileSystem } from "@effect/platform";

const ensureNewline = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

const decodeChunk = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

const makeOutputCapture = () => {
  const stdoutRef = Ref.unsafeMake<ReadonlyArray<string>>([]);
  const stderrRef = Ref.unsafeMake<ReadonlyArray<string>>([]);

  const append = (ref: Ref.Ref<ReadonlyArray<string>>, chunk: string | Uint8Array) =>
    Ref.update(ref, (items) => [...items, decodeChunk(chunk)]);

  const stdoutSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stdoutRef, chunk)
  );
  const stderrSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stderrRef, chunk)
  );

  const writeJson = (value: unknown, pretty?: boolean) =>
    append(
      stdoutRef,
      ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0))
    );

  const writeText = (value: string) =>
    append(stdoutRef, ensureNewline(value));

  const writeJsonStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.map((value) => `${JSON.stringify(value)}\n`),
      Stream.run(stdoutSink)
    );

  const writeStderr = (value: string) =>
    append(stderrRef, ensureNewline(value));

  const service: CliOutputService = {
    stdout: stdoutSink,
    stderr: stderrSink,
    writeJson,
    writeText,
    writeJsonStream,
    writeStderr
  };

  const layer = Layer.succeed(CliOutput, CliOutput.of(service));

  return { layer, stdoutRef, stderrRef };
};

describe("CLI derive command", () => {
  test("auto-creates target store when missing", async () => {
    const run = Command.run(deriveCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const { layer: outputLayer } = makeOutputCapture();
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
    const storeLayer = StoreManager.layer.pipe(
      Layer.provideMerge(appConfigLayer)
    );
    const storeLockLayer = StoreLock.layer.pipe(
      Layer.provideMerge(appConfigLayer)
    );
    const engineLayer = Layer.succeed(
      DerivationEngine,
      DerivationEngine.of({
        derive: () =>
          Effect.succeed(
            DerivationResult.make({
              eventsProcessed: 0,
              eventsMatched: 0,
              eventsSkipped: 0,
              deletesPropagated: 0,
              durationMs: 0
            })
          )
      })
    );
    const checkpointsLayer = Layer.succeed(
      ViewCheckpointStore,
      ViewCheckpointStore.of({
        load: () => Effect.succeed(Option.none()),
        save: () => Effect.void,
        remove: () => Effect.void
      })
    );
    const outputManagerLayer = Layer.succeed(
      OutputManager,
      OutputManager.of({
        materializeStore: (store) =>
          Effect.succeed({ store: store.name, filters: [] }),
        materializeFilters: () => Effect.succeed([])
      })
    );
    const filterLibraryLayer = Layer.succeed(
      FilterLibrary,
      FilterLibrary.of({
        list: () => Effect.succeed([]),
        get: (name) => Effect.fail(FilterNotFound.make({ name })),
        save: () => Effect.void,
        remove: () => Effect.void,
        validateAll: () => Effect.succeed([])
      })
    );
    const preferencesLayer = Layer.succeed(CliPreferences, { compact: false });
    const appLayer = Layer.mergeAll(
      outputLayer,
      storeLayer,
      storeLockLayer,
      engineLayer,
      checkpointsLayer,
      outputManagerLayer,
      filterLibraryLayer,
      preferencesLayer,
      appConfigLayer
    ).pipe(Layer.provideMerge(BunContext.layer));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const manager = yield* StoreManager;
        const sourceName = Schema.decodeUnknownSync(StoreName)("source");
        const targetName = Schema.decodeUnknownSync(StoreName)("target");

        yield* manager.createStore(sourceName, defaultStoreConfig);
        yield* run([
          "node",
          "skygent",
          "source",
          "target",
          "--filter-json",
          "{\"_tag\":\"All\"}"
        ]);

        return yield* manager.getStore(targetName);
      }).pipe(Effect.provide(appLayer))
    );

    expect(Option.isSome(result)).toBe(true);

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(storeRoot, { recursive: true });
      }).pipe(Effect.provide(BunContext.layer))
    );
  });
});

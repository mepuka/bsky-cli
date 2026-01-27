import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref, Sink, Stream } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { logErrorEvent } from "../../src/cli/logging.js";
import { storeCommand } from "../../src/cli/store.js";
import { LineageStore } from "../../src/services/lineage-store.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreCleaner } from "../../src/services/store-cleaner.js";
import { CliPreferences } from "../../src/cli/preferences.js";

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

describe("CLI store command", () => {
  test("writes JSON to stdout and keeps stderr clean", async () => {
    const run = Command.run(storeCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const { layer, stdoutRef, stderrRef } = makeOutputCapture();
    const storeLayer = Layer.mergeAll(
      StoreManager.layer,
      LineageStore.layer
    ).pipe(Layer.provide(KeyValueStore.layerMemory));
    const cleanerLayer = Layer.succeed(
      StoreCleaner,
      StoreCleaner.of({
        deleteStore: () => Effect.succeed({ deleted: false } as const)
      })
    );
    const preferencesLayer = Layer.succeed(CliPreferences, { compact: false });
    const appLayer = Layer.mergeAll(
      layer,
      storeLayer,
      cleanerLayer,
      preferencesLayer,
      BunContext.layer
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* run(["node", "skygent", "list"]);
        yield* run(["node", "skygent", "create", "demo"]);
        yield* run(["node", "skygent", "show", "demo"]);
      }).pipe(Effect.provide(appLayer))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const stderr = await Effect.runPromise(Ref.get(stderrRef));

    expect(stderr.length).toBe(0);

    const payloads = stdout
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

    const stderr = await Effect.runPromise(Ref.get(stderrRef));
    expect(stderr.length).toBe(1);
    const first = stderr[0];
    if (!first) {
      throw new Error("Expected stderr output");
    }
    const payload = JSON.parse(first);
    expect(payload.level).toBe("ERROR");
    expect(payload.message).toBe("boom");
    expect(payload.code).toBe(123);
  });
});

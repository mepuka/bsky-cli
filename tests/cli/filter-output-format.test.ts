import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Ref, Sink, Stream, TestContext } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { filterCommand } from "../../src/cli/filter.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { PostParser } from "../../src/services/post-parser.js";

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
    append(stdoutRef, ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0)));

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

const configLayer = Layer.succeed(ConfigOverrides, { outputFormat: "json" });
const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(configLayer));

const emptyLibraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.make({
    list: () => Effect.succeed([]),
    get: (name) => Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

const runtimeLayer = Layer.succeed(
  FilterRuntime,
  FilterRuntime.make({
    evaluate: () => Effect.succeed(() => Effect.succeed(false)),
    evaluateWithMetadata: () => Effect.succeed(() => Effect.succeed({ ok: false })),
    evaluateBatch: () =>
      Effect.succeed((posts) => Effect.succeed(Chunk.map(posts, () => false))),
    explain: () => Effect.succeed(() => Effect.succeed({ ok: false, reasons: [] }))
  })
);

const buildLayer = () => {
  const { layer: outputLayer, stdoutRef } = makeOutputCapture();
  const appLayer = Layer.mergeAll(
    outputLayer,
    appConfigLayer,
    emptyLibraryLayer,
    runtimeLayer,
    PostParser.layer
  ).pipe(Layer.provideMerge(BunContext.layer));
  return { appLayer, stdoutRef };
};

const parseJsonOutput = async (stdoutRef: Ref.Ref<ReadonlyArray<string>>) => {
  const stdout = await Effect.runPromise(Ref.get(stdoutRef));
  return JSON.parse(stdout.join("").trim()) as unknown;
};

describe("filter output format defaults", () => {
  test("filter describe uses config output format when --format is omitted", async () => {
    const run = Command.run(filterCommand, { name: "skygent", version: "0.0.0" });
    const { appLayer, stdoutRef } = buildLayer();

    await Effect.runPromise(
      run(["node", "skygent", "describe", "--filter", "hashtag:#ai"]).pipe(
        Effect.provide(appLayer),
        Effect.provide(TestContext.TestContext)
      )
    );

    const payload = await parseJsonOutput(stdoutRef);
    expect(typeof payload).toBe("object");
    expect(payload).toHaveProperty("summary");
  });

  test("filter test uses config output format when --format is omitted", async () => {
    const run = Command.run(filterCommand, { name: "skygent", version: "0.0.0" });
    const { appLayer, stdoutRef } = buildLayer();

    const rawPost = {
      uri: "at://did:plc:example/app.bsky.feed.post/1",
      author: "alice.bsky.social",
      record: {
        text: "hello world",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    };

    await Effect.runPromise(
      run([
        "node",
        "skygent",
        "test",
        "--filter",
        "hashtag:#ai",
        "--post-json",
        JSON.stringify(rawPost)
      ]).pipe(Effect.provide(appLayer), Effect.provide(TestContext.TestContext))
    );

    const payload = await parseJsonOutput(stdoutRef);
    expect(typeof payload).toBe("object");
    expect(payload).toHaveProperty("ok");
  });
});

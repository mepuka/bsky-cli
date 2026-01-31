import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Chunk, Clock, Effect, Layer, Ref, Sink, Stream } from "effect";
import { CliInput, type CliInputService } from "../../src/cli/input.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { pipeCommand } from "../../src/cli/pipe.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { PostParser } from "../../src/services/post-parser.js";
import type { FilterExpr } from "../../src/domain/filter.js";
import type { Post } from "../../src/domain/post.js";

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

const makeInputLayer = (lines: ReadonlyArray<string>) => {
  const service: CliInputService = {
    lines: Stream.fromIterable(lines)
  };
  return Layer.succeed(CliInput, CliInput.of(service));
};

const matches = (expr: FilterExpr, post: Post) => {
  switch (expr._tag) {
    case "Contains": {
      const target = expr.caseSensitive ? post.text : post.text.toLowerCase();
      const needle = expr.caseSensitive ? expr.text : expr.text.toLowerCase();
      return target.includes(needle);
    }
    case "All":
      return true;
    default:
      return true;
  }
};

const runtimeLayer = Layer.succeed(
  FilterRuntime,
  FilterRuntime.of({
    evaluate: (expr) =>
      Effect.succeed((post) => Effect.succeed(matches(expr, post))),
    evaluateWithMetadata: (expr) =>
      Effect.succeed((post) => Effect.succeed({ ok: matches(expr, post) })),
    evaluateBatch: (expr) =>
      Effect.succeed((posts) =>
        Effect.succeed(Chunk.map(posts, (post) => matches(expr, post)))
      ),
    explain: () => Effect.die("not implemented")
  })
);

const libraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.of({
    list: () => Effect.succeed([]),
    get: (name) => Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

const clockLayer = Layer.succeed(Clock.Clock, Clock.make());

const makeRawPost = (text: string, uri: string) => ({
  uri,
  author: "alice.bsky.social",
  record: {
    text,
    createdAt: "2026-01-01T00:00:00Z"
  }
});

describe("pipe command", () => {
  test("filters raw posts from stdin and outputs matches", async () => {
    const run = Command.run(pipeCommand, { name: "skygent", version: "0.0.0" });
    const { layer: outputLayer, stdoutRef, stderrRef } = makeOutputCapture();
    const inputLines = [
      JSON.stringify(makeRawPost("match me", "at://did:plc:1/app.bsky.feed.post/1")),
      JSON.stringify(makeRawPost("skip me", "at://did:plc:2/app.bsky.feed.post/2"))
    ];
    const inputLayer = makeInputLayer(inputLines);
    const appLayer = Layer.mergeAll(
      outputLayer,
      inputLayer,
      runtimeLayer,
      libraryLayer,
      PostParser.layer,
      clockLayer
    );

    await Effect.runPromise(
      run([
        "node",
        "skygent",
        "--filter-json",
        JSON.stringify({ _tag: "Contains", text: "match" })
      ]).pipe(Effect.provide(appLayer))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const stderr = await Effect.runPromise(Ref.get(stderrRef));

    expect(stderr.length).toBe(0);
    const payloads = stdout
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ text: "match me" });
  });

  test("skips invalid input lines when on-error=skip", async () => {
    const run = Command.run(pipeCommand, { name: "skygent", version: "0.0.0" });
    const { layer: outputLayer, stdoutRef, stderrRef } = makeOutputCapture();
    const inputLines = [
      JSON.stringify(makeRawPost("first", "at://did:plc:3/app.bsky.feed.post/3")),
      "{invalid-json",
      JSON.stringify(makeRawPost("second", "at://did:plc:4/app.bsky.feed.post/4"))
    ];
    const inputLayer = makeInputLayer(inputLines);
    const appLayer = Layer.mergeAll(
      outputLayer,
      inputLayer,
      runtimeLayer,
      libraryLayer,
      PostParser.layer,
      clockLayer
    );

    await Effect.runPromise(
      run([
        "node",
        "skygent",
        "--filter-json",
        JSON.stringify({ _tag: "All" }),
        "--on-error",
        "skip"
      ]).pipe(Effect.provide(appLayer))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const stderr = await Effect.runPromise(Ref.get(stderrRef));

    const payloads = stdout
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(payloads).toHaveLength(2);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

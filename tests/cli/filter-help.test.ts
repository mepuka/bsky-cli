import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref, Sink, Stream } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { filterCommand } from "../../src/cli/filter.js";

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

describe("CLI filter help", () => {
  test("prints aliases and examples", async () => {
    const run = Command.run(filterCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const { layer, stdoutRef } = makeOutputCapture();

    await Effect.runPromise(
      run(["node", "skygent", "help"]).pipe(Effect.provide(layer))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const output = stdout.join("");

    expect(output).toContain("Aliases:");
    expect(output).toContain("has:images");
    expect(output).toContain("from:alice.bsky.social");
  });
});

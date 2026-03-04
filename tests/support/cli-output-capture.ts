import { Effect, Layer, Ref, Sink, Stream } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";

const ensureNewline = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

const decodeChunk = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

export type OutputCapture = {
  readonly layer: Layer.Layer<CliOutput>;
  readonly stdoutRef: Ref.Ref<ReadonlyArray<string>>;
  readonly stderrRef: Ref.Ref<ReadonlyArray<string>>;
};

export const makeOutputCapture = (): OutputCapture => {
  const stdoutRef = Ref.unsafeMake<ReadonlyArray<string>>([]);
  const stderrRef = Ref.unsafeMake<ReadonlyArray<string>>([]);

  const append = (ref: Ref.Ref<ReadonlyArray<string>>, chunk: string | Uint8Array) =>
    Ref.update(ref, (items) => [...items, decodeChunk(chunk)]);

  const stdoutSink = Sink.forEach((chunk: string | Uint8Array) => append(stdoutRef, chunk));
  const stderrSink = Sink.forEach((chunk: string | Uint8Array) => append(stderrRef, chunk));

  const writeJson = (value: unknown, pretty?: boolean) =>
    append(stdoutRef, ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0)));

  const writeText = (value: string) => append(stdoutRef, ensureNewline(value));

  const writeJsonStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.map((value) => `${JSON.stringify(value)}\n`),
      Stream.run(stdoutSink)
    );

  const writeStderr = (value: string) => append(stderrRef, ensureNewline(value));

  const service: CliOutputService = {
    stdout: stdoutSink,
    stderr: stderrSink,
    writeJson,
    writeText,
    writeJsonStream,
    writeStderr
  };

  return {
    layer: Layer.succeed(CliOutput, CliOutput.of(service)),
    stdoutRef,
    stderrRef
  };
};

export const readStdout = (stdoutRef: Ref.Ref<ReadonlyArray<string>>) =>
  Effect.runPromise(Ref.get(stdoutRef).pipe(Effect.map((chunks) => chunks.join(""))));

export const readStderr = (stderrRef: Ref.Ref<ReadonlyArray<string>>) =>
  Effect.runPromise(Ref.get(stderrRef).pipe(Effect.map((chunks) => chunks.join(""))));

export const parseNdjson = <T>(text: string): ReadonlyArray<T> =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);

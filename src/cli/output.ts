import { BunSink } from "@effect/platform-bun";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Sink, Stream } from "effect";

const jsonLine = (value: unknown, pretty?: boolean) =>
  JSON.stringify(value, null, pretty ? 2 : 0);

const ensureNewline = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

const writeToSink = (
  sink: Sink.Sink<void, string | Uint8Array, never, PlatformError>,
  value: string
) => Stream.fromIterable([value]).pipe(Stream.run(sink));

export interface CliOutputService {
  readonly stdout: Sink.Sink<void, string | Uint8Array, never, PlatformError>;
  readonly stderr: Sink.Sink<void, string | Uint8Array, never, PlatformError>;
  readonly writeJson: (value: unknown, pretty?: boolean) => Effect.Effect<void, PlatformError>;
  readonly writeText: (value: string) => Effect.Effect<void, PlatformError>;
  readonly writeJsonStream: <A, E, R>(
    stream: Stream.Stream<A, E, R>
  ) => Effect.Effect<void, E | PlatformError, R>;
  readonly writeStderr: (value: string) => Effect.Effect<void, PlatformError>;
}

export class CliOutput extends Context.Tag("@skygent/CliOutput")<
  CliOutput,
  CliOutputService
>() {
  static readonly layer = Layer.succeed(
    CliOutput,
    (() => {
      const stdout = BunSink.fromWritable(
        () => process.stdout,
        (cause) =>
          new SystemError({
            module: "Stream",
            method: "stdout",
            reason: "Unknown",
            cause
          }),
        { endOnDone: false }
      );
      const stderr = BunSink.fromWritable(
        () => process.stderr,
        (cause) =>
          new SystemError({
            module: "Stream",
            method: "stderr",
            reason: "Unknown",
            cause
          }),
        { endOnDone: false }
      );

      return CliOutput.of({
        stdout,
        stderr,
        writeJson: (value, pretty) =>
          writeToSink(stdout, ensureNewline(jsonLine(value, pretty))),
        writeText: (value) => writeToSink(stdout, ensureNewline(value)),
        writeJsonStream: (stream) =>
          stream.pipe(
            Stream.map((value) => `${jsonLine(value)}\n`),
            Stream.run(stdout)
          ),
        writeStderr: (value) => writeToSink(stderr, ensureNewline(value))
      });
    })()
  );
}

export const writeJson = (value: unknown, pretty?: boolean) =>
  Effect.flatMap(CliOutput, (output) => output.writeJson(value, pretty));

export const writeText = (value: string) =>
  Effect.flatMap(CliOutput, (output) => output.writeText(value));

export const writeJsonStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Effect.Effect<void, E | PlatformError, R | CliOutput> =>
  Effect.flatMap(CliOutput, (output) => output.writeJsonStream(stream));

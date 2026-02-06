import { BunSink } from "@effect/platform-bun";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Effect, Sink, Stream } from "effect";

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

export class CliOutput extends Effect.Service<CliOutput>()("@skygent/CliOutput", {
  succeed: (() => {
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

    return {
      stdout,
      stderr,
      writeJson: (value: unknown, pretty?: boolean) =>
        writeToSink(stdout, ensureNewline(jsonLine(value, pretty))),
      writeText: (value: string) => writeToSink(stdout, ensureNewline(value)),
      writeJsonStream: <A, E, R>(stream: Stream.Stream<A, E, R>) =>
        stream.pipe(
          Stream.map((value) => `${jsonLine(value)}\n`),
          Stream.run(stdout)
        ),
      writeStderr: (value: string) => writeToSink(stderr, ensureNewline(value))
    };
  })()
}) {
  static readonly layer = CliOutput.Default;
}

export const writeJson = (value: unknown, pretty?: boolean) =>
  Effect.flatMap(CliOutput, (output) => output.writeJson(value, pretty));

export const writeText = (value: string) =>
  Effect.flatMap(CliOutput, (output) => output.writeText(value));

export const writeJsonStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Effect.Effect<void, E | PlatformError, R | CliOutput> =>
  Effect.flatMap(CliOutput, (output) => output.writeJsonStream(stream));

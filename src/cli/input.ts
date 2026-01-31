import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Stream } from "effect";
import { createInterface } from "node:readline";

export interface CliInputService {
  readonly lines: Stream.Stream<string, PlatformError>;
}

const makeLines = () =>
  Stream.unwrapScoped(
    Effect.acquireRelease(
      Effect.sync(() =>
        createInterface({
          input: process.stdin,
          crlfDelay: Infinity
        })
      ),
      (rl) => Effect.sync(() => rl.close())
    ).pipe(
      Effect.map((rl) =>
        Stream.fromAsyncIterable(
          rl,
          (cause) =>
            new SystemError({
              module: "Stream",
              method: "stdin",
              reason: "Unknown",
              cause
            })
        )
      )
    )
  );

export class CliInput extends Context.Tag("@skygent/CliInput")<
  CliInput,
  CliInputService
>() {
  static readonly layer = Layer.succeed(
    CliInput,
    CliInput.of({
      lines: makeLines()
    })
  );
}

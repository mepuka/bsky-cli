import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Stream } from "effect";
import { createInterface } from "node:readline";
import { fstatSync } from "node:fs";
import { isatty } from "node:tty";

export interface CliInputService {
  readonly lines: Stream.Stream<string, PlatformError>;
  readonly isTTY: boolean;
  readonly isReadable: boolean;
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
      lines: makeLines(),
      isTTY: Boolean(process.stdin.isTTY || isatty(process.stdin.fd ?? 0)),
      isReadable: (() => {
        try {
          const fd = process.stdin.fd ?? 0;
          const stat = fstatSync(fd);
          return stat.isFIFO() || stat.isFile() || stat.isSocket();
        } catch {
          return false;
        }
      })()
    })
  );
}

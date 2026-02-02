import { BunStream } from "@effect/platform-bun";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Context, Layer, Stream } from "effect";
import { fstatSync } from "node:fs";
import { isatty } from "node:tty";

export interface CliInputService {
  readonly lines: Stream.Stream<string, PlatformError>;
  readonly isTTY: boolean;
  readonly isReadable: boolean;
}

const makeLines = () => {
  const decoder = new TextDecoder();
  return BunStream.fromReadable(
    () => process.stdin,
    (cause) =>
      new SystemError({
        module: "Stream",
        method: "stdin",
        reason: "Unknown",
        cause
      }),
    { closeOnDone: false }
  ).pipe(
    Stream.map((chunk) => decoder.decode(chunk, { stream: true })),
    Stream.concat(Stream.succeed(decoder.decode())),
    Stream.splitLines
  );
};

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

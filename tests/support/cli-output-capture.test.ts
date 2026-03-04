import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { CliOutput } from "../../src/cli/output.js";
import {
  makeOutputCapture,
  parseNdjson,
  readStderr,
  readStdout
} from "./cli-output-capture.js";

describe("cli-output-capture support", () => {
  test("captures stdout and stderr writes", async () => {
    const capture = makeOutputCapture();

    await Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* CliOutput;
        yield* output.writeText("hello");
        yield* output.writeJson({ ok: true });
        yield* output.writeStderr("warn");
      }).pipe(Effect.provide(capture.layer))
    );

    const stdout = await readStdout(capture.stdoutRef);
    const stderr = await readStderr(capture.stderrRef);

    expect(stdout).toContain("hello\n");
    expect(stdout).toContain('{"ok":true}');
    expect(stderr).toContain("warn\n");
  });

  test("parseNdjson parses line-delimited json", () => {
    const parsed = parseNdjson<{ id: number }>("{\"id\":1}\n{\"id\":2}\n");
    expect(parsed).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

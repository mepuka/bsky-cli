import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { filterCommand } from "../../src/cli/filter.js";
import { makeOutputCapture, readStdout } from "../support/cli-output-capture.js";

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

    const output = await readStdout(stdoutRef);

    expect(output).toContain("Aliases:");
    expect(output).toContain("has:images");
    expect(output).toContain("from:alice.bsky.social");
  });
});

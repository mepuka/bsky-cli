import { describe, expect, test } from "bun:test";
import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "../../../src/cli/doc/annotation.js";
import { renderPlain, renderAnsi } from "../../../src/cli/doc/render.js";

describe("render", () => {
  const doc: Doc.Doc<Annotation> = Doc.annotate(Doc.text("hello"), "accent");

  test("renderPlain produces no ANSI escapes", () => {
    const output = renderPlain(doc);
    expect(output).toBe("hello");
    expect(output).not.toMatch(/\u001b\[/);
  });

  test("renderAnsi contains ANSI escape codes", () => {
    const output = renderAnsi(doc);
    expect(output).toContain("hello");
    expect(output).toMatch(/\u001b\[[0-9;]*m/);
  });

  test("renderPlain respects width", () => {
    const wide = Doc.reflow("a very long sentence that should wrap at some point");
    const output = renderPlain(wide as Doc.Doc<Annotation>, 20);
    expect(output).toContain("\n");
  });
});

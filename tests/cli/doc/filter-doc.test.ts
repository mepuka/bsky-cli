import { describe, expect, test } from "bun:test";
import { renderPlain, renderAnsi } from "../../../src/cli/doc/render.js";
import { renderFilterDescriptionDoc } from "../../../src/cli/doc/filter.js";
import { describeFilter } from "../../../src/domain/filter-describe.js";
import { and, not } from "../../../src/domain/filter.js";
import type { FilterExpr } from "../../../src/domain/filter.js";

const hashtag = (tag: string): FilterExpr => ({ _tag: "Hashtag", tag } as any);
const author = (handle: string): FilterExpr => ({ _tag: "Author", handle } as any);

describe("renderFilterDescriptionDoc", () => {
  test("renders simple filter description", () => {
    const desc = describeFilter(hashtag("#ai"));
    const doc = renderFilterDescriptionDoc(desc);
    const output = renderPlain(doc);
    expect(output).toContain("Posts with hashtag #ai");
    expect(output).toContain("Breakdown:");
    expect(output).toContain("Must have hashtag: #ai");
    expect(output).toContain("Mode compatibility:");
    expect(output).toContain("EventTime: YES");
    expect(output).toContain("DeriveTime: YES");
    expect(output).toContain("Effectful: No");
    expect(output).toContain("Estimated cost:");
    expect(output).toContain("Complexity:");
  });

  test("renders AND filter with multiple conditions", () => {
    const desc = describeFilter(and(hashtag("#ai"), author("alice.bsky.social")));
    const doc = renderFilterDescriptionDoc(desc);
    const output = renderPlain(doc);
    expect(output).toContain("#ai");
    expect(output).toContain("alice.bsky.social");
  });

  test("renders NOT filter with negation", () => {
    const desc = describeFilter(not(hashtag("#spam")));
    const doc = renderFilterDescriptionDoc(desc);
    const output = renderPlain(doc);
    expect(output).toContain("Must NOT");
  });

  test("renders with ANSI colors", () => {
    const desc = describeFilter(hashtag("#ai"));
    const doc = renderFilterDescriptionDoc(desc);
    const output = renderAnsi(doc);
    expect(output).toContain("\x1b[");
    expect(output).toContain("#ai");
  });
});

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { and, not, or } from "../../src/domain/filter.js";
import { formatFilterExpr, describeFilter } from "../../src/domain/filter-describe.js";
import { Handle, Hashtag } from "../../src/domain/primitives.js";

describe("filter describe", () => {
  test("formats DSL expressions", () => {
    const handle = Schema.decodeUnknownSync(Handle)("alice.bsky.social");
    const tag = Schema.decodeUnknownSync(Hashtag)("#ai");
    const expr = and({ _tag: "Hashtag", tag }, { _tag: "Author", handle });

    expect(formatFilterExpr(expr)).toBe(
      "hashtag:#ai AND author:alice.bsky.social"
    );
  });

  test("summarizes conditions and compatibility", () => {
    const handle = Schema.decodeUnknownSync(Handle)("spambot.bsky.social");
    const tagAi = Schema.decodeUnknownSync(Hashtag)("#ai");
    const tagMl = Schema.decodeUnknownSync(Hashtag)("#ml");
    const expr = and(
      or({ _tag: "Hashtag", tag: tagAi }, { _tag: "Hashtag", tag: tagMl }),
      not({ _tag: "Author", handle })
    );

    const description = describeFilter(expr);

    expect(description.effectful).toBe(false);
    expect(description.eventTimeCompatible).toBe(true);
    expect(description.conditions[0]).toMatchObject({
      type: "Hashtag",
      operator: "OR"
    });
    expect(description.conditions[1]).toMatchObject({
      type: "Author",
      negated: true
    });
  });
});

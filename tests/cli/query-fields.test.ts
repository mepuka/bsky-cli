import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { parseFieldSelectors, projectFields } from "../../src/cli/query-fields.js";

describe("query fields", () => {
  test("parses presets and projects minimal fields", async () => {
    const selectorsOption = await Effect.runPromise(parseFieldSelectors("@minimal"));
    expect(Option.isSome(selectorsOption)).toBe(true);
    if (selectorsOption._tag === "None") return;

    const source = {
      uri: "at://post/1",
      author: "alice",
      text: "hello",
      createdAt: "2026-01-01T00:00:00Z",
      extra: "ignore"
    };
    const projected = projectFields(source, selectorsOption.value);
    expect(projected).toEqual({
      uri: "at://post/1",
      author: "alice",
      text: "hello",
      createdAt: "2026-01-01T00:00:00Z"
    });
  });

  test("projects nested fields and wildcards", async () => {
    const selectorsOption = await Effect.runPromise(
      parseFieldSelectors("metrics.likes,metrics.*")
    );
    expect(Option.isSome(selectorsOption)).toBe(true);
    if (selectorsOption._tag === "None") return;

    const source = {
      uri: "at://post/1",
      metrics: { likes: 5, reposts: 2 },
      author: "alice"
    };
    const projected = projectFields(source, selectorsOption.value);
    expect(projected).toEqual({
      metrics: { likes: 5, reposts: 2 }
    });
  });

  test("projects array subfields with wildcard", async () => {
    const selectorsOption = await Effect.runPromise(
      parseFieldSelectors("images.*.alt")
    );
    expect(Option.isSome(selectorsOption)).toBe(true);
    if (selectorsOption._tag === "None") return;

    const source = {
      images: [
        { alt: "First", fullsizeUrl: "full1" },
        { alt: "Second", fullsizeUrl: "full2" }
      ],
      author: "alice"
    };
    const projected = projectFields(source, selectorsOption.value);
    expect(projected).toEqual({
      images: [{ alt: "First" }, { alt: "Second" }]
    });
  });

  test("merges array wildcard projections", async () => {
    const selectorsOption = await Effect.runPromise(
      parseFieldSelectors("images.*.alt,images.*.fullsizeUrl")
    );
    expect(Option.isSome(selectorsOption)).toBe(true);
    if (selectorsOption._tag === "None") return;

    const source = {
      images: [
        { alt: "First", fullsizeUrl: "full1" },
        { alt: "Second", fullsizeUrl: "full2" }
      ]
    };
    const projected = projectFields(source, selectorsOption.value);
    expect(projected).toEqual({
      images: [
        { alt: "First", fullsizeUrl: "full1" },
        { alt: "Second", fullsizeUrl: "full2" }
      ]
    });
  });

  test("returns none for @full", async () => {
    const selectorsOption = await Effect.runPromise(parseFieldSelectors("@full"));
    expect(Option.isNone(selectorsOption)).toBe(true);
  });
});

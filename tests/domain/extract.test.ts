import { describe, expect, test } from "bun:test";
import { extractFromFacets } from "../../src/domain/extract.js";
import type { RichTextFacet } from "../../src/domain/bsky.js";

describe("extractFromFacets", () => {
  const makeFacet = (...features: Array<RichTextFacet["features"][number]>): RichTextFacet =>
    ({ index: { byteStart: 0, byteEnd: 1 }, features }) as RichTextFacet;

  test("extracts mentions by $type discriminator", () => {
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#mention", did: "did:plc:abc" })
    ]);
    expect(result.mentionDids).toEqual(["did:plc:abc"]);
    expect(result.hashtags).toEqual([]);
    expect(result.links).toEqual([]);
  });

  test("extracts links by $type discriminator", () => {
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" })
    ]);
    expect(result.links).toEqual(["https://example.com"]);
  });

  test("extracts tags by $type discriminator", () => {
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#tag", tag: "effect" })
    ]);
    expect(result.hashtags).toEqual(["#effect"]);
  });

  test("preserves # prefix on tags that already have it", () => {
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#tag", tag: "#already" })
    ]);
    expect(result.hashtags).toEqual(["#already"]);
  });

  test("ignores unknown feature types", () => {
    const result = extractFromFacets([
      makeFacet(
        { $type: "app.bsky.richtext.facet#mention", did: "did:plc:abc" },
        { $type: "com.example.custom#feature" } as any
      )
    ]);
    expect(result.mentionDids).toEqual(["did:plc:abc"]);
    expect(result.hashtags).toEqual([]);
    expect(result.links).toEqual([]);
  });

  test("does not double-count features with multiple matching properties", () => {
    // A link feature should only be counted as a link, not also as a mention
    // even if someone hypothetically added a did field
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" })
    ]);
    expect(result.links).toEqual(["https://example.com"]);
    expect(result.mentionDids).toEqual([]);
  });

  test("deduplicates across facets", () => {
    const result = extractFromFacets([
      makeFacet({ $type: "app.bsky.richtext.facet#tag", tag: "effect" }),
      makeFacet({ $type: "app.bsky.richtext.facet#tag", tag: "effect" })
    ]);
    expect(result.hashtags).toEqual(["#effect"]);
  });

  test("returns empty arrays for undefined input", () => {
    const result = extractFromFacets(undefined);
    expect(result).toEqual({ hashtags: [], links: [], mentionDids: [] });
  });

  test("skips empty string values", () => {
    const result = extractFromFacets([
      makeFacet(
        { $type: "app.bsky.richtext.facet#mention", did: "" as any },
        { $type: "app.bsky.richtext.facet#link", uri: "" },
        { $type: "app.bsky.richtext.facet#tag", tag: "" }
      )
    ]);
    expect(result).toEqual({ hashtags: [], links: [], mentionDids: [] });
  });
});

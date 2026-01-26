import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { PostFromRaw } from "../../src/domain/raw.js";

describe("PostFromRaw", () => {
  test("decodes raw post into enriched Post", () => {
    const raw = {
      uri: "at://did:plc:abc123/app.bsky.feed.post/123",
      author: "alice.bsky",
      record: {
        text: "Hello @bob.bsky #effect https://example.com",
        createdAt: "2024-01-01T00:00:00.000Z",
        facets: [
          {
            index: { byteStart: 6, byteEnd: 15 },
            features: [
              {
                $type: "app.bsky.richtext.facet#mention",
                did: "did:plc:bob"
              }
            ]
          },
          {
            index: { byteStart: 16, byteEnd: 23 },
            features: [
              {
                $type: "app.bsky.richtext.facet#tag",
                tag: "effect"
              }
            ]
          },
          {
            index: { byteStart: 24, byteEnd: 43 },
            features: [
              {
                $type: "app.bsky.richtext.facet#link",
                uri: "https://example.com"
              }
            ]
          }
        ],
        tags: ["extra"]
      }
    };

    const post = Schema.decodeUnknownSync(PostFromRaw)(raw);
    expect(post.text).toBe("Hello @bob.bsky #effect https://example.com");
    expect(post.hashtags.map(String).sort()).toEqual(["#effect", "#extra"]);
    expect(post.mentions.map(String)).toEqual(["bob.bsky"]);
    expect(post.mentionDids?.map(String)).toEqual(["did:plc:bob"]);
    expect(post.links.map((link) => link.toString())).toEqual([
      "https://example.com/"
    ]);
    expect(post.createdAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  test("rejects invalid handle in raw post", () => {
    const raw = {
      uri: "at://did:plc:abc123/app.bsky.feed.post/123",
      author: "@bad",
      record: {
        text: "hello",
        createdAt: "2024-01-01T00:00:00.000Z"
      }
    };
    expect(() => Schema.decodeUnknownSync(PostFromRaw)(raw)).toThrow();
  });
});

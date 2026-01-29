import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { renderPlain } from "../../../src/cli/doc/render.js";
import { renderThread } from "../../../src/cli/doc/thread.js";
import { Post } from "../../../src/domain/post.js";

const makePost = (uri: string, text: string, createdAt: string, parentUri?: string) =>
  Schema.decodeUnknownSync(Post)({
    uri,
    author: "alice.bsky.social",
    text,
    createdAt,
    hashtags: [],
    mentions: [],
    links: [],
    ...(parentUri
      ? { reply: { root: { uri: parentUri, cid: "cid" }, parent: { uri: parentUri, cid: "cid" } } }
      : {}),
  });

describe("renderThread", () => {
  test("flat posts become roots", () => {
    const posts = [
      makePost("at://did:plc:a/app.bsky.feed.post/1", "First", "2024-01-01T00:00:00Z"),
      makePost("at://did:plc:a/app.bsky.feed.post/2", "Second", "2024-01-02T00:00:00Z"),
    ];
    const output = renderPlain(renderThread(posts, { compact: true }));
    expect(output).toContain("First");
    expect(output).toContain("Second");
    // Both are roots, no tree connectors for root nodes
    expect(output).not.toContain("└──");
  });

  test("reply becomes child of parent", () => {
    const posts = [
      makePost("at://did:plc:a/app.bsky.feed.post/1", "Parent", "2024-01-01T00:00:00Z"),
      makePost("at://did:plc:a/app.bsky.feed.post/2", "Child", "2024-01-02T00:00:00Z",
        "at://did:plc:a/app.bsky.feed.post/1"),
    ];
    const output = renderPlain(renderThread(posts, { compact: true }));
    expect(output).toContain("└──");
    expect(output).toContain("Child");
  });

  test("orphan reply (missing parent) becomes root", () => {
    const posts = [
      makePost("at://did:plc:a/app.bsky.feed.post/2", "Orphan", "2024-01-02T00:00:00Z",
        "at://did:plc:a/app.bsky.feed.post/missing"),
    ];
    const output = renderPlain(renderThread(posts, { compact: true }));
    expect(output).toContain("Orphan");
    expect(output).not.toContain("└──");
  });

  test("card mode renders full post details", () => {
    const posts = [
      makePost("at://did:plc:a/app.bsky.feed.post/1", "Hello world", "2024-01-01T12:00:00Z"),
    ];
    const output = renderPlain(renderThread(posts));
    // Card mode is default — should show full ISO timestamp
    expect(output).toContain("2024-01-01T12:00:00.000Z");
    expect(output).toContain("Hello world");
  });

  test("sorts by timestamp", () => {
    const posts = [
      makePost("at://did:plc:a/app.bsky.feed.post/2", "Second", "2024-01-02T00:00:00Z"),
      makePost("at://did:plc:a/app.bsky.feed.post/1", "First", "2024-01-01T00:00:00Z"),
    ];
    const output = renderPlain(renderThread(posts, { compact: true }));
    const firstIdx = output.indexOf("First");
    const secondIdx = output.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

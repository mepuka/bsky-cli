import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import * as Doc from "@effect/printer/Doc";
import { renderPlain, renderAnsi } from "../../../src/cli/doc/render.js";
import { renderPostCompact, renderPostCard } from "../../../src/cli/doc/post.js";
import { renderThread } from "../../../src/cli/doc/thread.js";
import { Post } from "../../../src/domain/post.js";

const makePost = (overrides: Partial<{
  uri: string;
  author: string;
  text: string;
  createdAt: string;
  replyParentUri: string;
}> = {}) =>
  Schema.decodeUnknownSync(Post)({
    uri: overrides.uri ?? "at://did:plc:test/app.bsky.feed.post/123",
    author: overrides.author ?? "alice.bsky.social",
    text: overrides.text ?? "Hello world",
    createdAt: overrides.createdAt ?? "2024-01-15T12:00:00Z",
    hashtags: [],
    mentions: [],
    links: [],
    ...(overrides.replyParentUri
      ? { reply: { root: { uri: overrides.replyParentUri, cid: "bafyreifake" }, parent: { uri: overrides.replyParentUri, cid: "bafyreifake" } } }
      : {}),
  });

describe("compact format", () => {
  test("renders multiple posts with vsep", () => {
    const posts = [makePost({ text: "First" }), makePost({ text: "Second", uri: "at://did:plc:test/app.bsky.feed.post/456" })];
    const doc = Doc.vsep(posts.map(renderPostCompact));
    const output = renderPlain(doc);
    expect(output).toContain("First");
    expect(output).toContain("Second");
  });

  test("renders with ANSI", () => {
    const posts = [makePost()];
    const doc = Doc.vsep(posts.map(renderPostCompact));
    const output = renderAnsi(doc);
    expect(output).toContain("alice.bsky.social");
    // ANSI output contains escape codes
    expect(output).toContain("\x1b[");
  });

  test("respects width", () => {
    const posts = [makePost()];
    const doc = Doc.vsep(posts.map(renderPostCompact));
    const narrow = renderPlain(doc, 40);
    expect(narrow).toContain("alice.bsky.social");
  });
});

describe("card format", () => {
  test("renders cards separated by blank lines", () => {
    const posts = [
      makePost({ text: "Card one" }),
      makePost({ text: "Card two", uri: "at://did:plc:test/app.bsky.feed.post/456" })
    ];
    const cards = posts.map((p) => Doc.vsep(renderPostCard(p)));
    const doc = Doc.vsep(
      cards.flatMap((card, i) => i < cards.length - 1 ? [card, Doc.empty] : [card])
    );
    const output = renderPlain(doc);
    expect(output).toContain("Card one");
    expect(output).toContain("Card two");
  });
});

describe("thread format", () => {
  test("renders thread tree from posts with replies", () => {
    const root = makePost({ text: "Root post", uri: "at://did:plc:test/app.bsky.feed.post/root" });
    const reply = makePost({
      text: "Reply post",
      uri: "at://did:plc:test/app.bsky.feed.post/reply",
      replyParentUri: "at://did:plc:test/app.bsky.feed.post/root"
    });
    const doc = renderThread([root, reply], { compact: false });
    const output = renderPlain(doc);
    expect(output).toContain("Root post");
    expect(output).toContain("Reply post");
  });

  test("compact thread uses single-line rendering", () => {
    const root = makePost({ text: "Root", uri: "at://did:plc:test/app.bsky.feed.post/root" });
    const doc = renderThread([root], { compact: true });
    const output = renderPlain(doc);
    expect(output).toContain("Root");
    expect(output).toContain("@alice.bsky.social");
  });
});

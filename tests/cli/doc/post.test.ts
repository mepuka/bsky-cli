import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import * as Doc from "@effect/printer/Doc";
import { renderPlain } from "../../../src/cli/doc/render.js";
import { renderPostCompact, renderPostCard } from "../../../src/cli/doc/post.js";
import { Post } from "../../../src/domain/post.js";
import { Handle, PostUri, Timestamp, Hashtag } from "../../../src/domain/primitives.js";
import { PostMetrics, EmbedImages, EmbedExternal, EmbedVideo, EmbedRecord, EmbedRecordWithMedia, EmbedRecordView, EmbedUnknown } from "../../../src/domain/bsky.js";

const makePost = (overrides: Partial<{
  text: string;
  metrics: InstanceType<typeof PostMetrics>;
  embed: any;
}> = {}) =>
  Schema.decodeUnknownSync(Post)({
    uri: "at://did:plc:test/app.bsky.feed.post/123",
    author: "alice.bsky.social",
    text: overrides.text ?? "Hello world",
    createdAt: "2024-01-15T12:00:00Z",
    hashtags: [],
    mentions: [],
    links: [],
    ...(overrides.metrics ? { metrics: overrides.metrics } : {}),
    ...(overrides.embed ? { embed: overrides.embed } : {}),
  });

describe("renderPostCompact", () => {
  test("renders author, date, text", () => {
    const post = makePost();
    const output = renderPlain(renderPostCompact(post));
    expect(output).toContain("@alice.bsky.social");
    expect(output).toContain("2024-01-15");
    expect(output).toContain("Hello world");
  });

  test("renders metrics", () => {
    const post = makePost({
      metrics: { likeCount: 42, repostCount: 5, replyCount: 3 } as any
    });
    const output = renderPlain(renderPostCompact(post));
    expect(output).toContain("♥ 42");
    expect(output).toContain("↻ 5");
    expect(output).toContain("💬 3");
  });

  test("omits zero metrics", () => {
    const post = makePost({
      metrics: { likeCount: 0, repostCount: 0, replyCount: 0 } as any
    });
    const output = renderPlain(renderPostCompact(post));
    expect(output).not.toContain("♥");
  });

  test("truncates long text", () => {
    const post = makePost({ text: "a".repeat(100) });
    const output = renderPlain(renderPostCompact(post));
    expect(output).toContain("...");
  });
});

describe("renderPostCard", () => {
  test("renders full timestamp", () => {
    const post = makePost();
    const output = renderPlain(Doc.vsep(renderPostCard(post)));
    expect(output).toContain("2024-01-15T12:00:00.000Z");
  });

  test("renders embed summary for images", () => {
    const post = makePost({
      embed: { _tag: "Images", images: [{ thumb: "t", fullsize: "f", alt: "" }] }
    });
    const output = renderPlain(Doc.vsep(renderPostCard(post)));
    expect(output).toContain("[Images: 1]");
  });

  test("renders embed summary for external link", () => {
    const post = makePost({
      embed: { _tag: "External", uri: "https://example.com", title: "Example", description: "" }
    });
    const output = renderPlain(Doc.vsep(renderPostCard(post)));
    expect(output).toContain("[Link: Example]");
  });

  test("renders embed summary for video", () => {
    const post = makePost({
      embed: { _tag: "Video", cid: "c", playlist: "p" }
    });
    const output = renderPlain(Doc.vsep(renderPostCard(post)));
    expect(output).toContain("[Video]");
  });

  test("renders embed summary for unknown", () => {
    const post = makePost({
      embed: { _tag: "Unknown", rawType: "x", data: {} }
    });
    const output = renderPlain(Doc.vsep(renderPostCard(post)));
    expect(output).toContain("[Embed]");
  });
});

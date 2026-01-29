import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { renderPostsMarkdown, renderPostsTable } from "../../src/domain/format.js";
import { Post } from "../../src/domain/post.js";

const post1 = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello world",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: []
});

const post2 = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/2",
  author: "bob.bsky",
  text: "Second post",
  createdAt: "2026-01-02T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: []
});

describe("cli format", () => {
  test("renderPostsTable renders header and rows", () => {
    const table = renderPostsTable([post1, post2]);
    const lines = table.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("Created At");
    expect(lines[0]).toContain("Author");
    expect(lines[0]).toContain("Text");
    expect(lines[0]).toContain("URI");
    expect(lines[2]).toContain(post1.createdAt.toISOString());
    expect(lines[2]).toContain(post1.author);
    expect(lines[3]).toContain(post2.createdAt.toISOString());
    expect(lines[3]).toContain(post2.author);
  });

  test("renderPostsMarkdown renders markdown table", () => {
    const markdown = renderPostsMarkdown([post1, post2]);
    const lines = markdown.split("\n");

    expect(lines[0]).toBe("| Created At | Author | Text | URI |");
    expect(lines[1]).toBe("| ---------- | ------ | ---- | --- |");
    expect(lines[2]).toContain(post1.createdAt.toISOString());
    expect(lines[3]).toContain(post2.createdAt.toISOString());
  });
});

import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { PostParser } from "../../src/services/post-parser.js";

describe("PostParser", () => {
  test("parsePost decodes valid raw posts", async () => {
    const raw = {
      uri: "at://did:plc:example/app.bsky.feed.post/1",
      author: "alice.bsky",
      record: {
        text: "Hello #effect",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    };

    const program = Effect.gen(function* () {
      const parser = yield* PostParser;
      return yield* parser.parsePost(raw);
    });

    const post = await Effect.runPromise(program.pipe(Effect.provide(PostParser.layer)));
    expect(post.uri).toBe(raw.uri);
    expect(post.author).toBe(raw.author);
    expect(post.text).toBe(raw.record.text);
  });

  test("parsePost fails on invalid raw payload", async () => {
    const raw = {
      uri: "at://did:plc:example/app.bsky.feed.post/1",
      author: "@bad",
      record: {
        text: "Hello #effect",
        createdAt: "not-a-timestamp"
      }
    };

    const program = Effect.gen(function* () {
      const parser = yield* PostParser;
      return yield* parser.parsePost(raw);
    });

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(PostParser.layer)));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Either, Layer, Request, RequestResolver, Schema } from "effect";
import { FilterExprSchema } from "../../src/domain/filter.js";
import { LlmDecisionMeta } from "../../src/domain/llm.js";
import { Post } from "../../src/domain/post.js";
import { EmbedExternal, EmbedRecord, EmbedRecordUnknown } from "../../src/domain/bsky.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { LlmDecision, LlmDecisionRequest } from "../../src/services/llm.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";

const decodeExpr = (input: unknown) => Schema.decodeUnknownSync(FilterExprSchema)(input);

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #effect",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#effect"],
  mentions: [],
  links: []
});

const replyPost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/9",
  author: "alice.bsky",
  text: "Replying here",
  createdAt: "2026-01-02T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: [],
  reply: {
    root: { uri: "at://did:plc:example/app.bsky.feed.post/root", cid: "cid-root" },
    parent: { uri: "at://did:plc:example/app.bsky.feed.post/parent", cid: "cid-parent" }
  }
});

const quotePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/10",
  author: "alice.bsky",
  text: "Quoting a post",
  createdAt: "2026-01-03T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: [],
  embed: EmbedRecord.make({
    recordType: "app.bsky.feed.post",
    record: EmbedRecordUnknown.make({ rawType: "unknown", data: {} })
  })
});

const mediaPost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/11",
  author: "alice.bsky",
  text: "Post with link preview",
  createdAt: "2026-01-04T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: [],
  embed: EmbedExternal.make({
    uri: "https://example.com",
    title: "Example",
    description: "Example link"
  })
});

const engagementPost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/12",
  author: "alice.bsky",
  text: "Popular post",
  createdAt: "2026-01-05T00:00:00.000Z",
  hashtags: ["#effect"],
  mentions: [],
  links: [],
  metrics: {
    likeCount: 120,
    repostCount: 12,
    replyCount: 5
  },
  langs: ["en"]
});

const linkValidatorLayer = Layer.succeed(
  LinkValidator,
  LinkValidator.of({
    isValid: (url) => Effect.succeed(url.includes("ok")),
    hasValidLink: (urls) => Effect.succeed(urls.some((url) => url.includes("ok")))
  })
);

const trendingLayer = Layer.succeed(
  TrendingTopics,
  TrendingTopics.of({
    getTopics: () => Effect.succeed(["effect", "bsky"]),
    isTrending: (tag) => Effect.succeed(String(tag) === "#effect")
  })
);

const runtimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(LlmDecision.testLayer),
  Layer.provideMerge(linkValidatorLayer),
  Layer.provideMerge(trendingLayer)
);

const makeLlmTestLayer = () => {
  const calls: Array<ReadonlyArray<LlmDecisionRequest>> = [];
  const makeMeta = (request: LlmDecisionRequest, keep: boolean) =>
    LlmDecisionMeta.make({
      promptHash: `prompt:${request.prompt}`,
      textHash: `text:${request.text}`,
      score: keep ? 1 : 0,
      minConfidence: request.minConfidence,
      keep,
      cached: false
    });
  const resolver = RequestResolver.makeBatched<LlmDecisionRequest, never>((requests) =>
    Effect.gen(function* () {
      calls.push(requests);
      yield* Effect.forEach(
        requests,
        (request) =>
          Request.succeed(request, makeMeta(request, request.text.includes("keep"))),
        { discard: true }
      );
    })
  );
  const layer = Layer.sync(LlmDecision, () =>
    LlmDecision.of({
      decideDetailed: (request) => Effect.request(request, resolver),
      decideDetailedBatch: (requests) =>
        Effect.forEach(requests, (request) => Effect.request(request, resolver), {
          batching: true,
          concurrency: "unbounded"
        }),
      decide: (request) =>
        Effect.request(request, resolver).pipe(Effect.map((meta) => meta.keep)),
      decideBatch: (requests) =>
        Effect.forEach(
          requests,
          (request) =>
            Effect.request(request, resolver).pipe(Effect.map((meta) => meta.keep)),
          { batching: true, concurrency: "unbounded" }
        )
    })
  );

  return { layer, calls };
};

describe("FilterRuntime", () => {
  test("evaluates author filter", async () => {
    const expr = decodeExpr({ _tag: "Author", handle: "alice.bsky" });
    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("short-circuits OR when left is true", async () => {
    const expr = decodeExpr({
      _tag: "Or",
      left: { _tag: "All" },
      right: {
        _tag: "Llm",
        prompt: "Should not run",
        minConfidence: 0.7,
        onError: { _tag: "Retry", maxRetries: 1, baseDelay: { _tag: "Millis", millis: 1 } }
      }
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("include policy returns true on failure", async () => {
    const expr = decodeExpr({
      _tag: "Llm",
      prompt: "Any prompt",
      minConfidence: 0.6,
      onError: { _tag: "Include" }
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("explain returns tree with short-circuit skip", async () => {
    const expr = decodeExpr({
      _tag: "And",
      left: { _tag: "None" },
      right: {
        _tag: "Llm",
        prompt: "Should be skipped",
        minConfidence: 0.7,
        onError: { _tag: "Include" }
      }
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const explainer = yield* runtime.explain(expr);
      return yield* explainer(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result.ok).toBe(false);
    expect(result.children?.[1]?.skipped).toBe(true);
  });

  test("evaluates regex filter against post text", async () => {
    const expr = decodeExpr({
      _tag: "Regex",
      patterns: ["hello", "#effect"],
      flags: "i"
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("evaluates contains filter", async () => {
    const expr = decodeExpr({ _tag: "Contains", text: "hello", caseSensitive: false });
    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("evaluates author/hashtag in filters", async () => {
    const authorExpr = decodeExpr({
      _tag: "AuthorIn",
      handles: ["alice.bsky", "bob.bsky"]
    });
    const hashtagExpr = decodeExpr({
      _tag: "HashtagIn",
      tags: ["#effect", "#ai"]
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const authorPredicate = yield* runtime.evaluate(authorExpr);
      const hashtagPredicate = yield* runtime.evaluate(hashtagExpr);
      const authorOk = yield* authorPredicate(samplePost);
      const hashtagOk = yield* hashtagPredicate(samplePost);
      return { authorOk, hashtagOk };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result.authorOk).toBe(true);
    expect(result.hashtagOk).toBe(true);
  });

  test("evaluates reply, quote, media, language, and engagement filters", async () => {
    const replyExpr = decodeExpr({ _tag: "IsReply" });
    const quoteExpr = decodeExpr({ _tag: "IsQuote" });
    const mediaExpr = decodeExpr({ _tag: "HasMedia" });
    const languageExpr = decodeExpr({ _tag: "Language", langs: ["en", "es"] });
    const engagementExpr = decodeExpr({ _tag: "Engagement", minLikes: 100 });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const replyPredicate = yield* runtime.evaluate(replyExpr);
      const quotePredicate = yield* runtime.evaluate(quoteExpr);
      const mediaPredicate = yield* runtime.evaluate(mediaExpr);
      const languagePredicate = yield* runtime.evaluate(languageExpr);
      const engagementPredicate = yield* runtime.evaluate(engagementExpr);
      return {
        replyOk: yield* replyPredicate(replyPost),
        quoteOk: yield* quotePredicate(quotePost),
        mediaOk: yield* mediaPredicate(mediaPost),
        languageOk: yield* languagePredicate(engagementPost),
        engagementOk: yield* engagementPredicate(engagementPost)
      };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result.replyOk).toBe(true);
    expect(result.quoteOk).toBe(true);
    expect(result.mediaOk).toBe(true);
    expect(result.languageOk).toBe(true);
    expect(result.engagementOk).toBe(true);
  });

  test("retry policy propagates failure", async () => {
    const expr = decodeExpr({
      _tag: "Llm",
      prompt: "Any prompt",
      minConfidence: 0.6,
      onError: { _tag: "Retry", maxRetries: 1, baseDelay: { _tag: "Millis", millis: 1 } }
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(
      Effect.either(program.pipe(Effect.provide(runtimeLayer)))
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("FilterEvalError");
    }
  });

  test("evaluates HasValidLinks with custom validator", async () => {
    const expr = decodeExpr({
      _tag: "HasValidLinks",
      onError: { _tag: "Exclude" }
    });

    const postWithLinks = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/3",
      author: "alice.bsky",
      text: "Check this out",
      createdAt: "2026-01-03T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: ["https://ok.test"]
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(postWithLinks);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("evaluates Trending filter using trending topics service", async () => {
    const expr = decodeExpr({
      _tag: "Trending",
      tag: "#effect",
      onError: { _tag: "Exclude" }
    });

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));
    expect(result).toBe(true);
  });

  test("evaluateWithMetadata collects LLM metadata", async () => {
    const expr = decodeExpr({
      _tag: "Llm",
      prompt: "Any prompt",
      minConfidence: 0.5,
      onError: { _tag: "Exclude" }
    });

    const { layer } = makeLlmTestLayer();
    const metadataLayer = FilterRuntime.layer.pipe(
      Layer.provideMerge(layer),
      Layer.provideMerge(linkValidatorLayer),
      Layer.provideMerge(trendingLayer)
    );

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluateWithMetadata(expr);
      return yield* predicate(samplePost);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(metadataLayer)));
    expect(result.llm.length).toBe(1);
    expect(result.llm[0]?.promptHash).toContain("prompt:");
  });

  test("evaluateBatch batches LLM requests", async () => {
    const expr = decodeExpr({
      _tag: "Llm",
      prompt: "Keep posts containing keep",
      minConfidence: 0.5,
      onError: { _tag: "Exclude" }
    });

    const samplePost2 = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/2",
      author: "bob.bsky",
      text: "please keep this one",
      createdAt: "2026-01-02T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: []
    });

    const { layer, calls } = makeLlmTestLayer();
    const batchedLayer = FilterRuntime.layer.pipe(
      Layer.provideMerge(layer),
      Layer.provideMerge(linkValidatorLayer),
      Layer.provideMerge(trendingLayer)
    );

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const evaluateBatch = yield* runtime.evaluateBatch(expr);
      return yield* evaluateBatch(Chunk.make(samplePost, samplePost2));
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(batchedLayer)));
    expect(Array.from(result)).toEqual([false, true]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.length).toBe(2);
  });
});

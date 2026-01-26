import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Either, Layer, Request, RequestResolver, Schema } from "effect";
import { FilterExprSchema } from "../../src/domain/filter.js";
import { LlmDecisionMeta } from "../../src/domain/llm.js";
import { Post } from "../../src/domain/post.js";
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

import { Args, Command, Options } from "@effect/cli";
import { formatSchemaError } from "./shared.js";
import { Chunk, Clock, Effect, Option, Stream } from "effect";
import { StoreQuery } from "../domain/events.js";
import { RawPost } from "../domain/raw.js";
import type { Post } from "../domain/post.js";
import { StoreName } from "../domain/primitives.js";
import { BskyClient } from "../services/bsky-client.js";
import { FilterCompiler } from "../services/filter-compiler.js";
import { FilterLibrary } from "../services/filter-library.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { PostParser } from "../services/post-parser.js";
import { StoreIndex } from "../services/store-index.js";
import { parseFilterExpr } from "./filter-input.js";
import { decodeJson } from "./parse.js";
import { writeJson, writeText } from "./output.js";
import { CliInputError, CliJsonError } from "./errors.js";
import { storeOptions } from "./store.js";
import { describeFilter, renderFilterDescription } from "../domain/filter-describe.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";

const filterNameArg = Args.text({ name: "name" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Filter name")
);

const postJsonOption = Options.text("post-json").pipe(
  Options.withDescription("Raw post JSON (app.bsky.feed.getPosts result)."),
  Options.optional
);
const postUriOption = Options.text("post-uri").pipe(
  Options.withDescription("Bluesky post URI (at://...)."),
  Options.optional
);
const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to sample for benchmarking")
);
const sampleSizeOption = Options.integer("sample-size").pipe(
  Options.withDescription("Number of posts to evaluate (default: 1000)"),
  Options.optional
);
const describeFormatOption = Options.choice("format", ["text", "json"]).pipe(
  Options.withDescription("Output format for filter descriptions (default: text)"),
  Options.optional
);

const requireFilterExpr = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) =>
  Option.match(filter, {
    onNone: () =>
      Option.match(filterJson, {
        onNone: () =>
          Effect.fail(
            CliInputError.make({
              message: "Provide --filter or --filter-json.",
              cause: { filter: null, filterJson: null }
            })
          ),
        onSome: () => Effect.void
      }),
    onSome: () => Effect.void
  });


const requireSinglePostInput = (
  postJson: Option.Option<string>,
  postUri: Option.Option<string>
) => {
  if (Option.isSome(postJson) && Option.isSome(postUri)) {
    return Effect.fail(
      CliInputError.make({
        message: "Use only one of --post-json or --post-uri.",
        cause: { postJson: true, postUri: true }
      })
    );
  }
  if (Option.isNone(postJson) && Option.isNone(postUri)) {
    return Effect.fail(
      CliInputError.make({
        message: "Provide --post-json or --post-uri.",
        cause: { postJson: null, postUri: null }
      })
    );
  }
  return Effect.void;
};

const parseRawPost = (raw: RawPost) =>
  Effect.gen(function* () {
    const parser = yield* PostParser;
    return yield* parser.parsePost(raw).pipe(
      Effect.mapError((error) =>
        CliInputError.make({
          message: `Invalid post payload: ${formatSchemaError(error)}`,
          cause: error
        })
      )
    );
  });

const loadPost = (
  postJson: Option.Option<string>,
  postUri: Option.Option<string>
): Effect.Effect<Post, CliInputError | CliJsonError, BskyClient | PostParser> =>
  Effect.gen(function* () {
    yield* requireSinglePostInput(postJson, postUri);
    if (Option.isSome(postJson)) {
      const raw = yield* decodeJson(RawPost, postJson.value);
      return yield* parseRawPost(raw);
    }
    if (Option.isSome(postUri)) {
      const client = yield* BskyClient;
      const raw = yield* client.getPost(postUri.value).pipe(
        Effect.mapError((error) =>
          CliInputError.make({
            message: `Failed to fetch post: ${error.message}`,
            cause: error
          })
        )
      );
      return yield* parseRawPost(raw);
    }
    return yield* CliInputError.make({
      message: "Provide --post-json or --post-uri.",
      cause: { postJson: null, postUri: null }
    });
  });

export const filterList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const library = yield* FilterLibrary;
    const names = yield* library.list();
    yield* writeJson(names);
  })
).pipe(
  Command.withDescription(
    withExamples("List saved filters", ["skygent filter list"])
  )
);

export const filterShow = Command.make(
  "show",
  { name: filterNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const library = yield* FilterLibrary;
      const expr = yield* library.get(name);
      yield* writeJson(expr);
    })
).pipe(
  Command.withDescription(
    withExamples("Show a saved filter", ["skygent filter show tech"])
  )
);

export const filterCreate = Command.make(
  "create",
  { name: filterNameArg, filter: filterOption, filterJson: filterJsonOption },
  ({ name, filter, filterJson }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const library = yield* FilterLibrary;
      yield* library.save(name, expr);
      yield* writeJson({ name, saved: true });
    })
).pipe(
  Command.withDescription(
    withExamples("Create or update a saved filter", [
      "skygent filter create tech --filter 'hashtag:#tech'"
    ])
  )
);

export const filterDelete = Command.make(
  "delete",
  { name: filterNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const library = yield* FilterLibrary;
      yield* library.remove(name);
      yield* writeJson({ name, deleted: true });
    })
).pipe(
  Command.withDescription(
    withExamples("Delete a saved filter", ["skygent filter delete tech"])
  )
);

export const filterValidateAll = Command.make("validate-all", {}, () =>
  Effect.gen(function* () {
    const library = yield* FilterLibrary;
    const results = yield* library.validateAll();
    const summary = {
      ok: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length
    };
    yield* writeJson({ summary, results });
  })
).pipe(
  Command.withDescription(
    withExamples("Validate all saved filters", ["skygent filter validate-all"])
  )
);

export const filterValidate = Command.make(
  "validate",
  { filter: filterOption, filterJson: filterJsonOption },
  ({ filter, filterJson }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const compiler = yield* FilterCompiler;
      yield* compiler.validate(expr);
      yield* writeJson({ ok: true });
    })
).pipe(
  Command.withDescription(
    withExamples("Validate a filter expression", [
      "skygent filter validate --filter 'author:alice.bsky.social'"
    ])
  )
);

export const filterTest = Command.make(
  "test",
  {
    filter: filterOption,
    filterJson: filterJsonOption,
    postJson: postJsonOption,
    postUri: postUriOption
  },
  ({ filter, filterJson, postJson, postUri }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(expr);
      const post = yield* loadPost(postJson, postUri);
      const ok = yield* predicate(post);
      yield* writeJson({
        ok,
        post: { uri: post.uri, author: post.author },
        filter: expr
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Test a filter against a single post", [
      "skygent filter test --filter 'hashtag:#ai' --post-uri at://did:plc:example/app.bsky.feed.post/xyz"
    ])
  )
);

export const filterExplain = Command.make(
  "explain",
  {
    filter: filterOption,
    filterJson: filterJsonOption,
    postJson: postJsonOption,
    postUri: postUriOption
  },
  ({ filter, filterJson, postJson, postUri }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const runtime = yield* FilterRuntime;
      const explainer = yield* runtime.explain(expr);
      const post = yield* loadPost(postJson, postUri);
      const explanation = yield* explainer(post);
      yield* writeJson({
        ok: explanation.ok,
        post: { uri: post.uri, author: post.author },
        explanation
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Explain why a post matches a filter", [
      "skygent filter explain --filter 'hashtag:#ai' --post-uri at://did:plc:example/app.bsky.feed.post/xyz"
    ])
  )
);

export const filterBenchmark = Command.make(
  "benchmark",
  {
    store: storeOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    sampleSize: sampleSizeOption
  },
  ({ store, filter, filterJson, sampleSize }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const runtime = yield* FilterRuntime;
      const index = yield* StoreIndex;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const limit = Option.getOrElse(sampleSize, () => 1000);
      const evaluateBatch = yield* runtime.evaluateBatch(expr);
      const query = StoreQuery.make({ limit });
      const stream = index.query(storeRef, query);
      const start = yield* Clock.currentTimeMillis;
      const result = yield* stream.pipe(
        Stream.grouped(50),
        Stream.runFoldEffect(
          { processed: 0, matched: 0 },
          (state, batch) =>
            evaluateBatch(batch).pipe(
              Effect.map((results) => {
                const processed = state.processed + Chunk.size(batch);
                const matched =
                  state.matched +
                  Chunk.toReadonlyArray(results).filter(Boolean).length;
                return { processed, matched };
              })
            )
        )
      );
      const end = yield* Clock.currentTimeMillis;
      const durationMs = end - start;
      const avgMs = result.processed > 0 ? durationMs / result.processed : 0;
      yield* writeJson({
        store: storeRef.name,
        processed: result.processed,
        matched: result.matched,
        durationMs,
        avgMsPerPost: avgMs,
        sampleSize: limit
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Benchmark filter performance over stored posts", [
      "skygent filter benchmark --store my-store --filter 'hashtag:#ai' --sample-size 500"
    ])
  )
);

export const filterDescribe = Command.make(
  "describe",
  { filter: filterOption, filterJson: filterJsonOption, format: describeFormatOption },
  ({ filter, filterJson, format }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const description = describeFilter(expr);
      const outputFormat = Option.getOrElse(format, () => "text" as const);
      if (outputFormat === "json") {
        yield* writeJson(description);
        return;
      }
      yield* writeText(renderFilterDescription(description));
    })
).pipe(
  Command.withDescription(
    withExamples("Describe a filter in human-readable form", [
      "skygent filter describe --filter 'hashtag:#ai'",
      "skygent filter describe --filter 'hashtag:#ai' --format json"
    ])
  )
);

export const filterCommand = Command.make("filter", {}).pipe(
  Command.withSubcommands([
    filterList,
    filterShow,
    filterCreate,
    filterDelete,
    filterValidateAll,
    filterValidate,
    filterTest,
    filterExplain,
    filterBenchmark,
    filterDescribe
  ]),
  Command.withDescription(
    withExamples("Manage saved filters and filter tooling", [
      "skygent filter list"
    ])
  )
);

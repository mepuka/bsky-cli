import { Args, Command, Options } from "@effect/cli";
import { formatSchemaError } from "./shared.js";
import { Chunk, Clock, Effect, Option, Stream } from "effect";
import { StoreQuery } from "../domain/events.js";
import { RawPost } from "../domain/raw.js";
import type { Post } from "../domain/post.js";
import type { FilterExpr } from "../domain/filter.js";
import { PostUri, StoreName } from "../domain/primitives.js";
import { BskyClient } from "../services/bsky-client.js";
import { FilterCompiler } from "../services/filter-compiler.js";
import { FilterLibrary } from "../services/filter-library.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { PostParser } from "../services/post-parser.js";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import { parseFilterExpr } from "./filter-input.js";
import { decodeJson } from "./parse.js";
import { writeJson, writeText } from "./output.js";
import { CliInputError, CliJsonError } from "./errors.js";
import { storeOptions } from "./store.js";
import { describeFilter, formatFilterExpr } from "../domain/filter-describe.js";
import { renderFilterDescriptionDoc } from "./doc/filter.js";
import { renderPlain, renderAnsi } from "./doc/render.js";
import { renderTableLegacy } from "./doc/table.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { jsonTableFormats, resolveOutputFormat, textJsonFormats } from "./output-format.js";
import { filterHelpText } from "./filter-help.js";
import { PositiveInt } from "./option-schemas.js";

const filterNameArg = Args.text({ name: "name" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Filter name")
);

const postJsonOption = Options.text("post-json").pipe(
  Options.withDescription("Raw post JSON (app.bsky.feed.getPosts result)."),
  Options.optional
);
const postUriOption = Options.text("post-uri").pipe(
  Options.withSchema(PostUri),
  Options.withDescription("Bluesky post URI (at://...)."),
  Options.optional
);
const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to sample for benchmarking")
);
const storeTestOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to sample for filter testing"),
  Options.optional
);
const testLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Number of posts to evaluate (default: 100)"),
  Options.optional
);
const sampleSizeOption = Options.integer("sample-size").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Number of posts to evaluate (default: 1000)"),
  Options.optional
);
const describeFormatOption = Options.choice("format", textJsonFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);
const testFormatOption = Options.choice("format", textJsonFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);
const listFormatOption = Options.choice("format", jsonTableFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);
const describeAnsiOption = Options.boolean("ansi").pipe(
  Options.withDescription("Enable ANSI colors in output")
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

const filterExprEquals = (left: FilterExpr, right: FilterExpr) =>
  JSON.stringify(left) === JSON.stringify(right);

export const filterList = Command.make("list", { format: listFormatOption }, ({ format }) =>
  Effect.gen(function* () {
    const appConfig = yield* AppConfigService;
    const library = yield* FilterLibrary;
    const names = yield* library.list();
    const outputFormat = resolveOutputFormat(
      format,
      appConfig.outputFormat,
      jsonTableFormats,
      "json"
    );

    if (outputFormat === "table") {
      const filters = yield* Effect.forEach(names, (name) =>
        library.get(name as StoreName).pipe(Effect.map((expr) => ({ name, expr: formatFilterExpr(expr) })))
      );
      const rows = filters.map((f) => [f.name, f.expr]);
      const table = renderTableLegacy(["NAME", "EXPRESSION"], rows);
      yield* writeText(table);
      return;
    }
    
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
      const existing = yield* library.get(name).pipe(
        Effect.map(Option.some),
        Effect.catchTag("FilterNotFound", () => Effect.succeed(Option.none()))
      );
      const action =
        Option.isNone(existing)
          ? ("created" as const)
          : filterExprEquals(existing.value, expr)
            ? ("unchanged" as const)
            : ("updated" as const);
      if (action !== "unchanged") {
        yield* library.save(name, expr);
      }
      yield* writeJson({ name, saved: action !== "unchanged", action });
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
      yield* writeJson({ name, deleted: true, action: "deleted" });
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
    postUri: postUriOption,
    store: storeTestOption,
    limit: testLimitOption,
    format: testFormatOption
  },
  ({ filter, filterJson, postJson, postUri, store, limit, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const runtime = yield* FilterRuntime;
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        textJsonFormats,
        "text"
      );
      if (Option.isSome(store)) {
        if (Option.isSome(postJson) || Option.isSome(postUri)) {
          return yield* CliInputError.make({
            message: "Use either --store or --post-json/--post-uri, not both.",
            cause: { store: store.value, postJson, postUri }
          });
        }
        const storeRef = yield* storeOptions.loadStoreRef(store.value);
        const index = yield* StoreIndex;
        const evaluateBatch = yield* runtime.evaluateBatch(expr);
        const sampleLimit = Option.getOrElse(limit, () => 100);
        const query = StoreQuery.make({ scanLimit: sampleLimit, order: "desc" });
        const stream = index.query(storeRef, query);
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
        if (outputFormat === "json") {
          yield* writeJson({
            store: storeRef.name,
            processed: result.processed,
            matched: result.matched,
            limit: sampleLimit,
            filter: expr,
            filterText: formatFilterExpr(expr)
          });
          return;
        }
        const lines = [
          `Matched: ${result.matched}/${result.processed}`,
          `Store: ${storeRef.name}`,
          `Filter: ${formatFilterExpr(expr)}`
        ];
        yield* writeText(lines.join("\n"));
        return;
      }

      const predicate = yield* runtime.evaluate(expr);
      const post = yield* loadPost(postJson, postUri);
      const ok = yield* predicate(post);
      if (outputFormat === "json") {
        yield* writeJson({
          ok,
          post: { uri: post.uri, author: post.author },
          filter: expr,
          filterText: formatFilterExpr(expr)
        });
        return;
      }
      const author = post.author ? ` by ${post.author}` : "";
      const lines = [
        `Match: ${ok ? "yes" : "no"}`,
        `Post: ${post.uri}${author}`,
        `Filter: ${formatFilterExpr(expr)}`
      ];
      yield* writeText(lines.join("\n"));
    })
).pipe(
  Command.withDescription(
    withExamples("Test a filter against a post or store sample", [
      "skygent filter test --filter 'hashtag:#ai' --post-uri at://did:plc:example/app.bsky.feed.post/xyz",
      "skygent filter test --filter 'engagement:minLikes=10' --store my-store --limit 100"
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
      const query = StoreQuery.make({ scanLimit: limit, order: "desc" });
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
  { filter: filterOption, filterJson: filterJsonOption, format: describeFormatOption, ansi: describeAnsiOption },
  ({ filter, filterJson, format, ansi }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const description = describeFilter(expr);
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        textJsonFormats,
        "text"
      );
      if (outputFormat === "json") {
        yield* writeJson(description);
        return;
      }
      const doc = renderFilterDescriptionDoc(description);
      yield* writeText(ansi ? renderAnsi(doc) : renderPlain(doc));
    })
).pipe(
  Command.withDescription(
    withExamples("Describe a filter in human-readable form", [
      "skygent filter describe --filter 'hashtag:#ai'",
      "skygent filter describe --filter 'hashtag:#ai' --format json"
    ])
  )
);

export const filterHelp = Command.make("help", {}, () => writeText(filterHelpText())).pipe(
  Command.withDescription(
    withExamples("Show filter DSL and JSON help", ["skygent filter help"])
  )
);

export const filterCommand = Command.make("filter", {}).pipe(
  Command.withSubcommands([
    filterHelp,
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

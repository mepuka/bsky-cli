import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option, Stream } from "effect";
import { all } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsMarkdown, renderPostsTable } from "../domain/format.js";
import { parseOptionalFilterExpr } from "./filter-input.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { parseRange } from "./range.js";
import { storeOptions } from "./store.js";
import { CliPreferences } from "./preferences.js";
import { projectFields, resolveFieldSelectors } from "./query-fields.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";

const storeNameArg = Args.text({ name: "store" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Store name to query")
);
const rangeOption = Options.text("range").pipe(
  Options.withDescription("ISO range as <start>..<end>"),
  Options.optional
);
const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of posts to return"),
  Options.optional
);
const formatOption = Options.choice("format", [
  "json",
  "ndjson",
  "markdown",
  "table"
]).pipe(
  Options.optional,
  Options.withDescription("Output format (default: config output format)")
);
const fieldsOption = Options.text("fields").pipe(
  Options.withDescription(
    "Comma-separated fields to include (supports dot notation and presets: @minimal, @social, @full)"
  ),
  Options.optional
);

const parseRangeOption = (range: Option.Option<string>) =>
  Option.match(range, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) => parseRange(raw).pipe(Effect.map(Option.some))
  });


export const queryCommand = Command.make(
  "query",
  {
    store: storeNameArg,
    range: rangeOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    limit: limitOption,
    format: formatOption,
    fields: fieldsOption
  },
  ({ store, range, filter, filterJson, limit, format, fields }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;
      const preferences = yield* CliPreferences;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOption(range);
      const parsedFilter = yield* parseOptionalFilterExpr(filter, filterJson);
      const expr = Option.getOrElse(parsedFilter, () => all());
      const outputFormat = Option.getOrElse(format, () => appConfig.outputFormat);
      const compact = preferences.compact;
      const selectorsOption = yield* resolveFieldSelectors(fields, compact);
      const project = (post: Post) =>
        Option.match(selectorsOption, {
          onNone: () => post,
          onSome: (selectors) => projectFields(post, selectors)
        });
      if (Option.isSome(selectorsOption) && outputFormat !== "json" && outputFormat !== "ndjson") {
        return yield* CliInputError.make({
          message: "--fields is only supported with json or ndjson output.",
          cause: { format: outputFormat }
        });
      }

      if (Option.isSome(limit) && limit.value <= 0) {
        return yield* CliInputError.make({
          message: "--limit must be a positive integer.",
          cause: { limit: limit.value }
        });
      }

      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        limit: Option.getOrUndefined(limit)
      });

      const predicate = yield* runtime.evaluate(expr);
      const stream = index
        .query(storeRef, query)
        .pipe(Stream.filterEffect((post) => predicate(post)));

      if (outputFormat === "ndjson") {
        yield* writeJsonStream(stream.pipe(Stream.map(project)));
        return;
      }

      const collected = yield* Stream.runCollect(stream);
      const posts = Chunk.toReadonlyArray(collected);
      const projectedPosts = Option.isSome(selectorsOption) ? posts.map(project) : posts;

      switch (outputFormat) {
        case "json":
          yield* writeJson(projectedPosts);
          return;
        case "markdown":
          yield* writeText(renderPostsMarkdown(posts));
          return;
        case "table":
          yield* writeText(renderPostsTable(posts));
          return;
        default:
          yield* writeJson(projectedPosts);
      }
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Query a store with optional range and filter",
      [
        "skygent query my-store --limit 25 --format table",
        "skygent query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z --filter 'hashtag:#ai'"
      ],
      [
        "Tip: use --fields @minimal or --compact to reduce JSON output size."
      ]
    )
  )
);

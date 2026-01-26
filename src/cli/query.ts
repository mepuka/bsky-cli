import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option, Stream } from "effect";
import { FilterExprSchema, all } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName } from "../domain/primitives.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsMarkdown, renderPostsTable } from "./format.js";
import { decodeJson } from "./parse.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { parseRange } from "./range.js";
import { storeOptions } from "./store.js";

const storeNameArg = Args.text({ name: "store" }).pipe(Args.withSchema(StoreName));
const rangeOption = Options.text("range").pipe(
  Options.withDescription("ISO range as <start>..<end>"),
  Options.optional
);
const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription("Filter expression as JSON string"),
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
]).pipe(Options.optional, Options.withDescription("Output format"));

const parseFilter = (filterJson: Option.Option<string>) =>
  Option.match(filterJson, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) => decodeJson(FilterExprSchema, raw).pipe(Effect.map(Option.some))
  });

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
    filter: filterJsonOption,
    limit: limitOption,
    format: formatOption
  },
  ({ store, range, filter, limit, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOption(range);
      const parsedFilter = yield* parseFilter(filter);
      const expr = Option.getOrElse(parsedFilter, () => all());
      const outputFormat = Option.getOrElse(format, () => appConfig.outputFormat);

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
        yield* writeJsonStream(stream);
        return;
      }

      const collected = yield* Stream.runCollect(stream);
      const posts = Chunk.toReadonlyArray(collected);

      switch (outputFormat) {
        case "json":
          yield* writeJson(posts);
          return;
        case "markdown":
          yield* writeText(renderPostsMarkdown(posts));
          return;
        case "table":
          yield* writeText(renderPostsTable(posts));
          return;
        default:
          yield* writeJson(posts);
      }
    })
).pipe(Command.withDescription("Query a store with optional range and filter"));

import { Args, Command, Options } from "@effect/cli";
import { Chunk, Clock, Effect, Option, Ref, Stream } from "effect";
import * as Doc from "@effect/printer/Doc";
import { all } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsMarkdown, renderPostsTable } from "../domain/format.js";
import { renderPostCompact, renderPostCard } from "./doc/post.js";
import { renderThread } from "./doc/thread.js";
import { renderPlain, renderAnsi } from "./doc/render.js";
import { parseOptionalFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson, writeJsonStream, writeText } from "./output.js";
import { parseRange } from "./range.js";
import { storeOptions } from "./store.js";
import { CliPreferences } from "./preferences.js";
import { projectFields, resolveFieldSelectors } from "./query-fields.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { filterByFlags } from "../typeclass/chunk.js";

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
const scanLimitOption = Options.integer("scan-limit").pipe(
  Options.withDescription("Maximum rows to scan before filtering (advanced)"),
  Options.optional
);
const sortOption = Options.choice("sort", ["asc", "desc"]).pipe(
  Options.withDescription("Sort order for results (default: asc)"),
  Options.optional
);
const newestFirstOption = Options.boolean("newest-first").pipe(
  Options.withDescription("Sort newest posts first (alias for --sort desc)")
);
const formatOption = Options.choice("format", [
  "json",
  "ndjson",
  "markdown",
  "table",
  "compact",
  "card",
  "thread"
]).pipe(
  Options.optional,
  Options.withDescription("Output format (default: config output format)")
);
const ansiOption = Options.boolean("ansi").pipe(
  Options.withDescription("Enable ANSI colors in output")
);
const widthOption = Options.integer("width").pipe(
  Options.withDescription("Line width for terminal output"),
  Options.optional
);
const fieldsOption = Options.text("fields").pipe(
  Options.withDescription(
    "Comma-separated fields to include (supports dot notation and presets: @minimal, @social, @full). Use author or authorProfile.handle for handles."
  ),
  Options.optional
);
const progressOption = Options.boolean("progress").pipe(
  Options.withDescription("Show progress for filtered queries")
);

const DEFAULT_FILTER_SCAN_LIMIT = 5000;

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
    scanLimit: scanLimitOption,
    sort: sortOption,
    newestFirst: newestFirstOption,
    format: formatOption,
    ansi: ansiOption,
    width: widthOption,
    fields: fieldsOption,
    progress: progressOption
  },
  ({ store, range, filter, filterJson, limit, scanLimit, sort, newestFirst, format, ansi, width, fields, progress }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;
      const output = yield* CliOutput;
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

      const w = Option.getOrUndefined(width);

      if (Option.isSome(limit) && limit.value <= 0) {
        return yield* CliInputError.make({
          message: "--limit must be a positive integer.",
          cause: { limit: limit.value }
        });
      }
      if (Option.isSome(scanLimit) && scanLimit.value <= 0) {
        return yield* CliInputError.make({
          message: "--scan-limit must be a positive integer.",
          cause: { scanLimit: scanLimit.value }
        });
      }
      const sortValue = Option.getOrUndefined(sort);
      const order =
        newestFirst
          ? "desc"
          : sortValue;
      if (newestFirst && sortValue === "asc") {
        return yield* CliInputError.make({
          message: "--newest-first conflicts with --sort asc.",
          cause: { newestFirst, sort: sortValue }
        });
      }

      const hasFilter = Option.isSome(parsedFilter);
      const userLimit = Option.getOrUndefined(limit);
      const userScanLimit = Option.getOrUndefined(scanLimit);
      const defaultScanLimit =
        hasFilter && userScanLimit === undefined
          ? Math.max(userLimit !== undefined ? userLimit * 50 : 0, DEFAULT_FILTER_SCAN_LIMIT)
          : undefined;
      const resolvedScanLimit =
        hasFilter
          ? userScanLimit ?? defaultScanLimit
          : userScanLimit ?? userLimit;
      if (defaultScanLimit !== undefined) {
        yield* output
          .writeStderr(
            `ℹ️  Scanning up to ${defaultScanLimit} posts (filtered query). Use --scan-limit to scan more.`
          )
          .pipe(Effect.catchAll(() => Effect.void));
      }

      if (
        hasFilter &&
        Option.isNone(limit) &&
        (outputFormat === "thread" || outputFormat === "table")
      ) {
        yield* output
          .writeStderr(
            "Warning: thread/table output collects all matched posts in memory. Consider adding --limit."
          )
          .pipe(Effect.catchAll(() => Effect.void));
      }

      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        scanLimit: resolvedScanLimit,
        order
      });

      const baseStream = index.query(storeRef, query);
      const progressEnabled = hasFilter && progress;
      let startTime = 0;
      let progressRef: Ref.Ref<{ scanned: number; matched: number; lastReportAt: number }> | undefined;
      if (progressEnabled) {
        startTime = yield* Clock.currentTimeMillis;
        progressRef = yield* Ref.make({ scanned: 0, matched: 0, lastReportAt: startTime });
      }

      const reportProgress =
        progressEnabled && progressRef
          ? (scanned: number, matched: number, now: number) =>
              output
                .writeStderr(
                  `Query progress: scanned=${scanned} matched=${matched} elapsedMs=${now - startTime}`
                )
                .pipe(Effect.catchAll(() => Effect.void))
          : undefined;

      const onBatch =
        progressEnabled && progressRef && reportProgress
          ? (scannedDelta: number, matchedDelta: number) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const state = yield* Ref.get(progressRef);
                const scanned = state.scanned + scannedDelta;
                const matched = state.matched + matchedDelta;
                const shouldReport =
                  scanned % 1000 === 0 || now - state.lastReportAt >= 1000;
                if (shouldReport) {
                  yield* reportProgress(scanned, matched, now);
                }
                yield* Ref.set(progressRef, {
                  scanned,
                  matched,
                  lastReportAt: shouldReport ? now : state.lastReportAt
                });
              })
          : (_scanned: number, _matched: number) => Effect.void;

      const evaluateBatch = hasFilter ? yield* runtime.evaluateBatch(expr) : undefined;

      const filtered = hasFilter && evaluateBatch
        ? baseStream.pipe(
            Stream.grouped(50),
            Stream.mapEffect((batch) =>
              evaluateBatch(batch).pipe(
                Effect.map((flags) => {
                  const matched = filterByFlags(batch, flags);
                  return {
                    matched,
                    scanned: Chunk.size(batch),
                    matchedCount: Chunk.size(matched)
                  };
                }),
                Effect.tap(({ scanned, matchedCount }) => onBatch(scanned, matchedCount)),
                Effect.map(({ matched }) => matched)
              )
            ),
            Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
          )
        : baseStream;

      const stream = Option.match(limit, {
        onNone: () => filtered,
        onSome: (value) => filtered.pipe(Stream.take(value))
      });

      if (outputFormat === "ndjson") {
        yield* writeJsonStream(stream.pipe(Stream.map(project)));
        return;
      }
      if (outputFormat === "json") {
        const writeChunk = (value: string) =>
          Stream.fromIterable([value]).pipe(Stream.run(output.stdout));
        let isFirst = true;
        yield* writeChunk("[");
        yield* Stream.runForEach(stream.pipe(Stream.map(project)), (post) => {
          const json = JSON.stringify(post);
          const prefix = isFirst ? "" : ",\n";
          isFirst = false;
          return writeChunk(`${prefix}${json}`);
        });
        const suffix = isFirst ? "]\n" : "\n]\n";
        yield* writeChunk(suffix);
        return;
      }

      switch (outputFormat) {
        case "compact": {
          const render = (post: Post) =>
            ansi
              ? renderAnsi(renderPostCompact(post), w)
              : renderPlain(renderPostCompact(post), w);
          yield* Stream.runForEach(stream, (post) => writeText(render(post)));
          return;
        }
        case "card": {
          const rendered = stream.pipe(
            Stream.map((post) => {
              const doc = Doc.vsep(renderPostCard(post));
              return ansi ? renderAnsi(doc, w) : renderPlain(doc, w);
            }),
            Stream.mapAccum(true, (isFirst, text) => {
              const output = isFirst ? text : `\\n${text}`;
              return [false, output] as const;
            })
          );
          yield* Stream.runForEach(rendered, (text) => writeText(text));
          return;
        }
      }

      const collected = yield* Stream.runCollect(stream);
      const posts = Chunk.toReadonlyArray(collected);
      const projectedPosts = Option.isSome(selectorsOption) ? posts.map(project) : posts;

      switch (outputFormat) {
        case "markdown":
          yield* writeText(renderPostsMarkdown(posts));
          return;
        case "table":
          yield* writeText(renderPostsTable(posts));
          return;
        case "thread": {
          const doc = renderThread(
            posts,
            w === undefined ? { compact: false } : { compact: false, lineWidth: w }
          );
          yield* writeText(ansi ? renderAnsi(doc, w) : renderPlain(doc, w));
          return;
        }
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
        "skygent query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z --filter 'hashtag:#ai'",
        "skygent query my-store --format card --ansi",
        "skygent query my-store --format thread --ansi --width 120",
        "skygent query my-store --format compact --limit 50",
        "skygent query my-store --sort desc --limit 25"
      ],
      [
        "Tip: use --fields @minimal or --compact to reduce JSON output size."
      ]
    )
  )
);

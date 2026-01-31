import { Args, Command, Options } from "@effect/cli";
import { Chunk, Clock, Effect, Option, Ref, Schema, Stream } from "effect";
import * as Doc from "@effect/printer/Doc";
import { all } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName, Timestamp } from "../domain/primitives.js";
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
import { parseTimeInput } from "./time.js";
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
const sinceOption = Options.text("since").pipe(
  Options.withDescription(
    "Start time (ISO timestamp, date, relative duration like 24h, or now/today/yesterday)"
  ),
  Options.optional
);
const untilOption = Options.text("until").pipe(
  Options.withDescription(
    "End time (ISO timestamp, date, relative duration like 24h, or now/today/yesterday)"
  ),
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
const countOption = Options.boolean("count").pipe(
  Options.withDescription("Only output the count of matching posts")
);

const DEFAULT_FILTER_SCAN_LIMIT = 5000;

const isAscii = (value: string) => /^[\x00-\x7F]*$/.test(value);

const hasUnicodeInsensitiveContains = (expr: FilterExpr): boolean => {
  switch (expr._tag) {
    case "Contains":
      return !expr.caseSensitive && expr.text.length > 0 && !isAscii(expr.text);
    case "And":
      return (
        hasUnicodeInsensitiveContains(expr.left) ||
        hasUnicodeInsensitiveContains(expr.right)
      );
    case "Or":
      return (
        hasUnicodeInsensitiveContains(expr.left) ||
        hasUnicodeInsensitiveContains(expr.right)
      );
    case "Not":
      return hasUnicodeInsensitiveContains(expr.expr);
    default:
      return false;
  }
};

const parseRangeOptions = (
  range: Option.Option<string>,
  since: Option.Option<string>,
  until: Option.Option<string>
) =>
  Effect.gen(function* () {
    const toTimestamp = (date: Date, label: string) =>
      Schema.decodeUnknown(Timestamp)(date).pipe(
        Effect.mapError((cause) =>
          CliInputError.make({
            message: `Computed ${label} timestamp is invalid.`,
            cause
          })
        )
      );
    const hasRange = Option.isSome(range);
    const hasSince = Option.isSome(since);
    const hasUntil = Option.isSome(until);

    if (hasRange && (hasSince || hasUntil)) {
      return yield* CliInputError.make({
        message: "Use either --range or --since/--until, not both.",
        cause: { range: range.value, since: Option.getOrUndefined(since), until: Option.getOrUndefined(until) }
      });
    }

    if (hasRange) {
      const parsed = yield* parseRange(range.value);
      return Option.some(parsed);
    }

    if (!hasSince && !hasUntil) {
      return Option.none();
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis);

    const start = hasSince
      ? yield* parseTimeInput(since.value, now, { label: "--since" })
      : new Date(0);
    const end = hasUntil
      ? yield* parseTimeInput(until.value, now, { label: "--until" })
      : now;

    if (start.getTime() > end.getTime()) {
      return yield* CliInputError.make({
        message: `Invalid time range: start ${start.toISOString()} must be before end ${end.toISOString()}.`,
        cause: { start, end }
      });
    }

    const startTimestamp = yield* toTimestamp(start, "start");
    const endTimestamp = yield* toTimestamp(end, "end");
    return Option.some({ start: startTimestamp, end: endTimestamp });
  });


export const queryCommand = Command.make(
  "query",
  {
    store: storeNameArg,
    range: rangeOption,
    since: sinceOption,
    until: untilOption,
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
    progress: progressOption,
    count: countOption
  },
  ({ store, range, since, until, filter, filterJson, limit, scanLimit, sort, newestFirst, format, ansi, width, fields, progress, count }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;
      const output = yield* CliOutput;
      const preferences = yield* CliPreferences;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOptions(range, since, until);
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
      if (count && Option.isSome(selectorsOption)) {
        return yield* CliInputError.make({
          message: "--count cannot be combined with --fields.",
          cause: { count, fields }
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
      if (hasFilter && hasUnicodeInsensitiveContains(expr)) {
        yield* output
          .writeStderr(
            "Warning: Unicode case-insensitive contains filters cannot be pushed down; query may scan in-memory.\n"
          )
          .pipe(Effect.catchAll(() => Effect.void));
      }
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
      const trackScanLimit = hasFilter && resolvedScanLimit !== undefined;
      const scanRef = trackScanLimit
        ? yield* Ref.make({ scanned: 0, matched: 0 })
        : undefined;
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

      const onBatch = (scannedDelta: number, matchedDelta: number) =>
        Effect.gen(function* () {
          if (scanRef) {
            yield* Ref.update(scanRef, (state) => ({
              scanned: state.scanned + scannedDelta,
              matched: state.matched + matchedDelta
            }));
          }
          if (progressEnabled && progressRef && reportProgress) {
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
          }
        });

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

      const warnIfScanLimitReached = scanRef && resolvedScanLimit !== undefined
        ? () =>
            Ref.get(scanRef).pipe(
              Effect.flatMap((state) =>
                state.scanned >= resolvedScanLimit
                  ? output
                      .writeStderr(
                        `Warning: scan limit ${resolvedScanLimit} reached. Results may be truncated.\n`
                      )
                      .pipe(Effect.catchAll(() => Effect.void))
                  : Effect.void
              )
            )
        : () => Effect.void;

      if (count) {
        const canUseIndexCount =
          !hasFilter && Option.isNone(parsedRange);
        const total = canUseIndexCount
          ? yield* index.count(storeRef)
          : yield* Stream.runFold(stream, 0, (acc) => acc + 1);
        const limited = Option.match(limit, {
          onNone: () => total,
          onSome: (value) => Math.min(total, value)
        });
        yield* writeJson(limited);
        yield* warnIfScanLimitReached();
        return;
      }

      if (outputFormat === "ndjson") {
        const countRef = yield* Ref.make(0);
        const counted = stream.pipe(
          Stream.map(project),
          Stream.tap(() => Ref.update(countRef, (count) => count + 1))
        );
        yield* writeJsonStream(counted);
        const count = yield* Ref.get(countRef);
        if (count === 0) {
          yield* writeText("[]");
        }
        yield* warnIfScanLimitReached();
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
        yield* warnIfScanLimitReached();
        return;
      }

      switch (outputFormat) {
        case "compact": {
          const countRef = yield* Ref.make(0);
          const render = (post: Post) =>
            ansi
              ? renderAnsi(renderPostCompact(post), w)
              : renderPlain(renderPostCompact(post), w);
          yield* Stream.runForEach(stream, (post) =>
            Ref.update(countRef, (count) => count + 1).pipe(
              Effect.zipRight(writeText(render(post)))
            )
          );
          const count = yield* Ref.get(countRef);
          if (count === 0) {
            yield* writeText("No posts found.");
          }
          yield* warnIfScanLimitReached();
          return;
        }
        case "card": {
          const countRef = yield* Ref.make(0);
          const rendered = stream.pipe(
            Stream.map((post) => {
              const doc = Doc.vsep(renderPostCard(post));
              return ansi ? renderAnsi(doc, w) : renderPlain(doc, w);
            }),
            Stream.mapAccum(true, (isFirst, text) => {
              const output = isFirst ? text : `\\n${text}`;
              return [false, output] as const;
            }),
            Stream.tap(() => Ref.update(countRef, (count) => count + 1))
          );
          yield* Stream.runForEach(rendered, (text) => writeText(text));
          const count = yield* Ref.get(countRef);
          if (count === 0) {
            yield* writeText("No posts found.");
          }
          yield* warnIfScanLimitReached();
          return;
        }
      }

      const collected = yield* Stream.runCollect(stream);
      const posts = Chunk.toReadonlyArray(collected);
      const projectedPosts = Option.isSome(selectorsOption) ? posts.map(project) : posts;
      yield* warnIfScanLimitReached();

      switch (outputFormat) {
        case "markdown":
          yield* writeText(renderPostsMarkdown(posts));
          return;
        case "table":
          yield* writeText(renderPostsTable(posts));
          return;
        case "thread": {
          if (posts.length === 0) {
            yield* writeText("No posts found.");
            return;
          }
          // B3: Warn if query doesn't have thread relationships
          if (!hasFilter) {
            yield* output
              .writeStderr(
                "ℹ️  Query results don't have thread relationships. Posts will display in chronological order.\n"
              )
              .pipe(Effect.catchAll(() => Effect.void));
          }
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
      "Query a store with optional time range and filter",
      [
        "skygent query my-store --limit 25 --format table",
        "skygent query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z --filter 'hashtag:#ai'",
        "skygent query my-store --since 24h --filter 'hashtag:#ai'",
        "skygent query my-store --until 2024-01-15 --format compact",
        "skygent query my-store --format card --ansi",
        "skygent query my-store --format thread --ansi --width 120",
        "skygent query my-store --format compact --limit 50",
        "skygent query my-store --sort desc --limit 25",
        "skygent query my-store --filter 'contains:ai' --count"
      ],
      [
        "Tip: use --fields @minimal or --compact to reduce JSON output size."
      ]
    )
  )
);

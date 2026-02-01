import { Args, Command, Options } from "@effect/cli";
import { Chunk, Clock, Effect, Match, Option, Order, Ref, Schema, Stream } from "effect";
import * as Doc from "@effect/printer/Doc";
import { all } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName, Timestamp } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import type { StoreRef } from "../domain/store.js";
import type { ImageRef, ImageVariant } from "../domain/images.js";
import { extractImageRefs, summarizeEmbed } from "../domain/embeds.js";
import { ImageArchive } from "../services/images/image-archive.js";
import { ImageConfig } from "../services/images/image-config.js";
import { ImagePipeline } from "../services/images/image-pipeline.js";
import { FilterRuntime } from "../services/filter-runtime.js";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import {
  collapseWhitespace,
  renderPostsMarkdown,
  renderPostsTable,
  renderStorePostsMarkdown,
  renderStorePostsTable,
  truncate
} from "../domain/format.js";
import { renderPostCompact, renderPostCard } from "./doc/post.js";
import { renderThread } from "./doc/thread.js";
import { renderPlain, renderAnsi } from "./doc/render.js";
import { parseOptionalFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson, writeJsonStream, writeText } from "./output.js";
import { parseRange } from "./range.js";
import { parseTimeInput } from "./time.js";
import { CliPreferences } from "./preferences.js";
import { projectFields, resolveFieldSelectors } from "./query-fields.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { filterByFlags } from "../typeclass/chunk.js";
import { StoreManager } from "../services/store-manager.js";
import { StoreNotFound } from "../domain/errors.js";
import { StorePostOrder } from "../domain/order.js";
import { formatSchemaError } from "./shared.js";
import { mergeOrderedStreams } from "./stream-merge.js";
import { jsonNdjsonTableFormats, queryOutputFormats, resolveOutputFormat } from "./output-format.js";
import { PositiveInt } from "./option-schemas.js";
import { renderTableLegacy } from "./doc/table.js";
import { logWarn } from "./logging.js";

const storeNamesArg = Args.text({ name: "store" }).pipe(
  Args.repeated,
  Args.withDescription("Store name(s) to query (repeatable or comma-separated)")
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
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of posts to return"),
  Options.optional
);
const scanLimitOption = Options.integer("scan-limit").pipe(
  Options.withSchema(PositiveInt),
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
const formatOption = Options.choice("format", queryOutputFormats).pipe(
  Options.optional,
  Options.withDescription("Output format (default: config output format)")
);
const includeStoreOption = Options.boolean("include-store").pipe(
  Options.withDescription("Include store name in output")
);
const ansiOption = Options.boolean("ansi").pipe(
  Options.withDescription("Enable ANSI colors in output")
);
const widthOption = Options.integer("width").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Line width for terminal output"),
  Options.optional
);
const fieldsOption = Options.text("fields").pipe(
  Options.withDescription(
    "Comma-separated fields to include (supports dot notation and presets: @minimal, @social, @images, @embeds, @media, @full). Use author or authorProfile.handle for handles."
  ),
  Options.optional
);
const extractImagesOption = Options.boolean("extract-images").pipe(
  Options.withDescription("Emit one record per image embed (json/ndjson/table only)")
);
const resolveImagesOption = Options.boolean("resolve-images").pipe(
  Options.withDescription("Replace image URLs with local cache paths when available")
);
const cacheImagesOption = Options.boolean("cache-images").pipe(
  Options.withDescription("Fetch and cache images during query (implies --resolve-images)")
);
const progressOption = Options.boolean("progress").pipe(
  Options.withDescription("Show progress for filtered queries")
);
const countOption = Options.boolean("count").pipe(
  Options.withDescription("Only output the count of matching posts")
);

const DEFAULT_FILTER_SCAN_LIMIT = 5000;

type StorePost = {
  readonly store: StoreRef;
  readonly post: Post;
};

type ImageExtract = {
  readonly postUri: Post["uri"];
  readonly author: Post["author"];
  readonly imageUrl: ImageRef["fullsizeUrl"];
  readonly thumbUrl: ImageRef["thumbUrl"];
  readonly alt: ImageRef["alt"];
  readonly aspectRatio: ImageRef["aspectRatio"];
};

type FieldSelector = {
  readonly path: ReadonlyArray<string>;
  readonly wildcard: boolean;
};

const isAscii = (value: string) => /^[\x00-\x7F]*$/.test(value);

const selectorsIncludeImages = (selectors: ReadonlyArray<FieldSelector>) =>
  selectors.some(
    (selector) =>
      selector.path[0] === "images" ||
      (selector.wildcard && selector.path.length === 0)
  );

const hasUnicodeInsensitiveContains = (expr: FilterExpr): boolean =>
  Match.type<FilterExpr>().pipe(
    Match.tags({
      Contains: (contains) =>
        !contains.caseSensitive && contains.text.length > 0 && !isAscii(contains.text),
      AltText: (altText) => altText.text.length > 0 && !isAscii(altText.text),
      And: (andExpr) =>
        hasUnicodeInsensitiveContains(andExpr.left) ||
        hasUnicodeInsensitiveContains(andExpr.right),
      Or: (orExpr) =>
        hasUnicodeInsensitiveContains(orExpr.left) ||
        hasUnicodeInsensitiveContains(orExpr.right),
      Not: (notExpr) => hasUnicodeInsensitiveContains(notExpr.expr)
    }),
    Match.orElse(() => false)
  )(expr);

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

const splitStoreNames = (raw: ReadonlyArray<string>) =>
  raw.flatMap((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );

const parseStoreNames = (raw: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const names = splitStoreNames(raw);
    if (names.length === 0) {
      return yield* CliInputError.make({
        message: "Provide at least one store name.",
        cause: { stores: raw }
      });
    }
    return yield* Effect.forEach(
      names,
      (name) =>
        Schema.decodeUnknown(StoreName)(name).pipe(
          Effect.mapError((error) =>
            CliInputError.make({
              message: `Invalid store name "${name}": ${formatSchemaError(error)}`,
              cause: { name }
            })
          )
        ),
      { discard: false }
    );
  });

const loadStoreRefs = (names: ReadonlyArray<StoreName>) =>
  Effect.gen(function* () {
    const manager = yield* StoreManager;
    const results = yield* Effect.forEach(
      names,
      (name) => manager.getStore(name),
      { discard: false }
    );
    const missing = names.filter((_, index) => Option.isNone(results[index]!));
    if (missing.length > 0) {
      if (missing.length === 1 && names.length === 1) {
        return yield* StoreNotFound.make({ name: missing[0]! });
      }
      return yield* CliInputError.make({
        message: `Unknown stores: ${missing.join(", ")}`,
        cause: { missing }
      });
    }
    const stores = results
      .map((option) => (Option.isSome(option) ? option.value : undefined))
      .filter((value): value is NonNullable<typeof value> => value !== undefined);
    return stores;
  });


export const queryCommand = Command.make(
  "query",
  {
    stores: storeNamesArg,
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
    includeStore: includeStoreOption,
    ansi: ansiOption,
    width: widthOption,
    fields: fieldsOption,
    extractImages: extractImagesOption,
    resolveImages: resolveImagesOption,
    cacheImages: cacheImagesOption,
    progress: progressOption,
    count: countOption
  },
  ({ stores, range, since, until, filter, filterJson, limit, scanLimit, sort, newestFirst, format, includeStore, ansi, width, fields, extractImages, resolveImages, cacheImages, progress, count }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const runtime = yield* FilterRuntime;
      const output = yield* CliOutput;
      const preferences = yield* CliPreferences;
      const storeNames = yield* parseStoreNames(stores);
      const storeRefs = yield* loadStoreRefs(storeNames);
      const multiStore = storeRefs.length > 1;
      const includeStoreLabel = includeStore || multiStore;
      const parsedRange = yield* parseRangeOptions(range, since, until);
      const parsedFilter = yield* parseOptionalFilterExpr(filter, filterJson);
      const expr = Option.getOrElse(parsedFilter, () => all());
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        queryOutputFormats,
        "json"
      );
      if (extractImages && !jsonNdjsonTableFormats.includes(outputFormat as typeof jsonNdjsonTableFormats[number])) {
        return yield* CliInputError.make({
          message: "--extract-images only supports json, ndjson, or table output.",
          cause: { format: outputFormat }
        });
      }
      if (multiStore && outputFormat === "thread") {
        return yield* CliInputError.make({
          message: "Thread output is only supported for single-store queries.",
          cause: { format: outputFormat }
        });
      }
      if (extractImages && Option.isSome(fields)) {
        return yield* CliInputError.make({
          message: "--fields is not supported with --extract-images.",
          cause: { fields: fields.value }
        });
      }
      const compact = preferences.compact;
      const { selectors: selectorsOption, source: selectorsSource } =
        extractImages
          ? { selectors: Option.none(), source: "implicit" as const }
          : yield* resolveFieldSelectors(fields, compact);
      const imagesInOutput =
        extractImages ||
        Option.match(selectorsOption, {
          onNone: () => false,
          onSome: selectorsIncludeImages
        });
      if ((resolveImages || cacheImages) && !imagesInOutput) {
        return yield* CliInputError.make({
          message:
            "--resolve-images/--cache-images requires --extract-images or --fields including images.",
          cause: { resolveImages, cacheImages, fields: Option.getOrUndefined(fields) }
        });
      }
      if (cacheImages) {
        const imageConfig = yield* ImageConfig;
        if (!imageConfig.enabled) {
          return yield* CliInputError.make({
            message:
              "Image cache is disabled. Set SKYGENT_IMAGE_CACHE_ENABLED=true to enable caching.",
            cause: { cacheImages }
          });
        }
      }
      if (count && (resolveImages || cacheImages)) {
        return yield* CliInputError.make({
          message: "--count cannot be combined with --resolve-images or --cache-images.",
          cause: { count, resolveImages, cacheImages }
        });
      }
      const resolveImagesEffective = (resolveImages || cacheImages) && imagesInOutput;
      const fieldImagesSelected = Option.match(selectorsOption, {
        onNone: () => false,
        onSome: selectorsIncludeImages
      });
      const resolveFieldImages = resolveImagesEffective && fieldImagesSelected;

      const imagePipeline = resolveImagesEffective ? yield* ImagePipeline : undefined;
      const imageArchive = resolveImagesEffective ? yield* ImageArchive : undefined;

      const resolveCachedUrl = (url: string, variant: ImageVariant) =>
        resolveImagesEffective
          ? (cacheImages
              ? imagePipeline!.ensureCached(url, variant)
              : imagePipeline!.getCached(url, variant)
            ).pipe(
              Effect.map((cached) =>
                Option.match(cached, {
                  onNone: () => url,
                  onSome: (asset) => imageArchive!.resolvePath(asset)
                })
              ),
              Effect.catchAll((error) =>
                logWarn("Image cache failed", {
                  url,
                  variant,
                  error
                }).pipe(Effect.orElseSucceed(() => undefined), Effect.as(url))
              )
            )
          : Effect.succeed(url);

      const resolveImageRefs = (images: ReadonlyArray<ImageRef>) =>
        Effect.forEach(
          images,
          (image) =>
            Effect.all([
              resolveCachedUrl(image.fullsizeUrl, "original"),
              resolveCachedUrl(image.thumbUrl, "thumb")
            ]).pipe(
              Effect.map(([fullsizeUrl, thumbUrl]) => ({
                ...image,
                fullsizeUrl,
                thumbUrl
              }))
            ),
          { concurrency: "unbounded" }
        );
      const augmentPost = (post: Post) => {
        const embedSummary = summarizeEmbed(post.embed);
        const images = fieldImagesSelected ? extractImageRefs(post.embed) : [];
        return {
          ...post,
          ...(fieldImagesSelected ? { images } : {}),
          ...(embedSummary ? { embedSummary } : {})
        };
      };
      const augmentPostEffect = (post: Post) =>
        Effect.gen(function* () {
          const images = fieldImagesSelected ? extractImageRefs(post.embed) : [];
          const resolvedImages = resolveFieldImages
            ? yield* resolveImageRefs(images)
            : images;
          const embedSummary = summarizeEmbed(post.embed);
          return {
            ...post,
            ...(fieldImagesSelected ? { images: resolvedImages } : {}),
            ...(embedSummary ? { embedSummary } : {})
          };
        });
      const project = (post: Post) =>
        Option.match(selectorsOption, {
          onNone: () => post,
          onSome: (selectors) => projectFields(augmentPost(post), selectors)
        });
      const projectEffect = (post: Post) =>
        Effect.gen(function* () {
          if (Option.isNone(selectorsOption)) {
            return post;
          }
          const augmented = yield* augmentPostEffect(post);
          return projectFields(augmented, selectorsOption.value);
        });
      if (selectorsSource === "explicit" && outputFormat !== "json" && outputFormat !== "ndjson") {
        return yield* CliInputError.make({
          message: "--fields is only supported with json or ndjson output.",
          cause: { format: outputFormat }
        });
      }
      if (count && selectorsSource === "explicit") {
        return yield* CliInputError.make({
          message: "--count cannot be combined with --fields.",
          cause: { count, fields }
        });
      }

      const w = Option.getOrUndefined(width);

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
            `ℹ️  Scanning up to ${defaultScanLimit} posts${multiStore ? " per store" : ""} (filtered query). Use --scan-limit to scan more.`
          )
          .pipe(Effect.catchAll(() => Effect.void));
      }

      if (
        Option.isNone(limit) &&
        (outputFormat === "thread" || outputFormat === "table" || outputFormat === "markdown")
      ) {
        yield* output
          .writeStderr(
            "Warning: table/markdown/thread output collects all matched posts in memory. Consider adding --limit."
          )
          .pipe(Effect.catchAll(() => Effect.void));
      }

      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        scanLimit: resolvedScanLimit,
        order
      });

      const progressEnabled = hasFilter && progress;
      const trackScanLimit = hasFilter && resolvedScanLimit !== undefined;
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

      const onBatch = (
        scanRef: Ref.Ref<{ scanned: number; matched: number }> | undefined,
        scannedDelta: number,
        matchedDelta: number
      ) =>
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

      const buildStoreStream = (storeRef: StoreRef) =>
        Effect.gen(function* () {
          const scanRef = trackScanLimit
            ? yield* Ref.make({ scanned: 0, matched: 0 })
            : undefined;
          const baseStream = index.query(storeRef, query);
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
                    Effect.tap(({ scanned, matchedCount }) =>
                      onBatch(scanRef, scanned, matchedCount)
                    ),
                    Effect.map(({ matched }) => matched)
                  )
                ),
                Stream.mapConcat((chunk) => Chunk.toReadonlyArray(chunk))
              )
            : baseStream;
          const storeStream = filtered.pipe(
            Stream.map((post) => ({ store: storeRef, post }))
          );
          return { store: storeRef, stream: storeStream, scanRef };
        });

      const storeStreams = yield* Effect.forEach(storeRefs, buildStoreStream, {
        discard: false
      });
      const scanRefs = storeStreams
        .map((entry) =>
          entry.scanRef ? { store: entry.store, ref: entry.scanRef } : undefined
        )
        .filter((entry): entry is { store: StoreRef; ref: Ref.Ref<{ scanned: number; matched: number }> } => entry !== undefined);

      const storePostOrder =
        order === "desc" ? Order.reverse(StorePostOrder) : StorePostOrder;

      const merged = mergeOrderedStreams(
        storeStreams.map((entry) => entry.stream),
        storePostOrder
      );

      const postStream = Option.match(limit, {
        onNone: () => merged,
        onSome: (value) => merged.pipe(Stream.take(value))
      });

      const warnIfScanLimitReached = () =>
        resolvedScanLimit === undefined || scanRefs.length === 0
          ? Effect.void
          : Effect.forEach(
              scanRefs,
              ({ store, ref }) =>
                Ref.get(ref).pipe(
                  Effect.flatMap((state) =>
                    state.scanned >= resolvedScanLimit
                      ? output
                          .writeStderr(
                            multiStore
                              ? `Warning: scan limit ${resolvedScanLimit} reached for ${store.name}. Results may be truncated.\n`
                              : `Warning: scan limit ${resolvedScanLimit} reached. Results may be truncated.\n`
                          )
                          .pipe(Effect.catchAll(() => Effect.void))
                      : Effect.void
                  )
                ),
              { discard: true }
            );

      const toImageOutputs = (entry: StorePost): ReadonlyArray<ImageExtract & { store?: string }> => {
        const images = extractImageRefs(entry.post.embed);
        return images.map((image) => ({
          ...(includeStoreLabel ? { store: entry.store.name } : {}),
          postUri: entry.post.uri,
          author: entry.post.author,
          imageUrl: image.fullsizeUrl,
          thumbUrl: image.thumbUrl,
          alt: image.alt,
          aspectRatio: image.aspectRatio
        }));
      };

      const toImageOutputsResolved = (entry: StorePost) =>
        Effect.gen(function* () {
          const images = extractImageRefs(entry.post.embed);
          return yield* Effect.forEach(
            images,
            (image) =>
              Effect.all([
                resolveCachedUrl(image.fullsizeUrl, "original"),
                resolveCachedUrl(image.thumbUrl, "thumb")
              ]).pipe(
                Effect.map(([imageUrl, thumbUrl]) => ({
                  ...(includeStoreLabel ? { store: entry.store.name } : {}),
                  postUri: entry.post.uri,
                  author: entry.post.author,
                  imageUrl,
                  thumbUrl,
                  alt: image.alt,
                  aspectRatio: image.aspectRatio
                }))
              ),
            { concurrency: "unbounded" }
          );
        });

      const imageStreamBase = resolveImagesEffective
        ? postStream.pipe(
            Stream.mapEffect(toImageOutputsResolved),
            Stream.mapConcat((rows) => rows)
          )
        : postStream.pipe(Stream.mapConcat(toImageOutputs));

      const imageStream = extractImages ? imageStreamBase : Stream.empty;

      const toOutput = (entry: StorePost) => {
        const projected = project(entry.post);
        return includeStoreLabel ? { store: entry.store.name, post: projected } : projected;
      };

      const toOutputEffect = (entry: StorePost) =>
        projectEffect(entry.post).pipe(
          Effect.map((projected) =>
            includeStoreLabel ? { store: entry.store.name, post: projected } : projected
          )
        );

      const outputStream = resolveFieldImages
        ? postStream.pipe(Stream.mapEffect(toOutputEffect))
        : postStream.pipe(Stream.map(toOutput));

      if (count) {
        if (extractImages) {
          const total = yield* Stream.runFold(imageStream, 0, (acc) => acc + 1);
          yield* writeJson(total);
          yield* warnIfScanLimitReached();
          return;
        }
        const canUseIndexCount =
          !hasFilter && Option.isNone(parsedRange);
        const total = canUseIndexCount
          ? yield* Effect.forEach(storeRefs, (store) => index.count(store), {
              discard: false
            }).pipe(
              Effect.map((counts) => counts.reduce((sum, value) => sum + value, 0))
            )
          : yield* Stream.runFold(postStream, 0, (acc) => acc + 1);
        const limited = Option.match(limit, {
          onNone: () => total,
          onSome: (value) => Math.min(total, value)
        });
        yield* writeJson(limited);
        yield* warnIfScanLimitReached();
        return;
      }

      if (extractImages) {
        const formatAlt = (alt?: string) =>
          alt ? truncate(collapseWhitespace(alt), 60) : "";
        const formatAspect = (aspectRatio?: ImageRef["aspectRatio"]) =>
          aspectRatio ? `${aspectRatio.width}x${aspectRatio.height}` : "";
        const renderImageExtractsTable = (
          rows: ReadonlyArray<ImageExtract & { store?: string }>
        ) => {
          const headers = includeStoreLabel
            ? ["Store", "Post URI", "Author", "Image URL", "Thumb URL", "Alt", "Aspect"]
            : ["Post URI", "Author", "Image URL", "Thumb URL", "Alt", "Aspect"];
          const body = rows.map((row) => {
            const cells = [
              row.postUri,
              row.author,
              row.imageUrl,
              row.thumbUrl,
              formatAlt(row.alt),
              formatAspect(row.aspectRatio)
            ];
            return includeStoreLabel ? [row.store ?? "", ...cells] : cells;
          });
          return renderTableLegacy(headers, body);
        };

        if (outputFormat === "ndjson") {
          yield* writeJsonStream(imageStream);
          yield* warnIfScanLimitReached();
          return;
        }
        if (outputFormat === "json") {
          const writeChunk = (value: string) =>
            Stream.fromIterable([value]).pipe(Stream.run(output.stdout));
          let isFirst = true;
          yield* writeChunk("[");
          yield* Stream.runForEach(imageStream, (value) => {
            const json = JSON.stringify(value);
            const prefix = isFirst ? "" : ",\n";
            isFirst = false;
            return writeChunk(`${prefix}${json}`);
          });
          const suffix = isFirst ? "]\n" : "\n]\n";
          yield* writeChunk(suffix);
          yield* warnIfScanLimitReached();
          return;
        }
        if (outputFormat === "table") {
          const collected = yield* Stream.runCollect(imageStream);
          const rows = Chunk.toReadonlyArray(collected);
          yield* writeText(renderImageExtractsTable(rows));
          yield* warnIfScanLimitReached();
          return;
        }
      }

      if (outputFormat === "ndjson") {
        yield* writeJsonStream(outputStream);
        yield* warnIfScanLimitReached();
        return;
      }
      if (outputFormat === "json") {
        const writeChunk = (value: string) =>
          Stream.fromIterable([value]).pipe(Stream.run(output.stdout));
        let isFirst = true;
        yield* writeChunk("[");
        yield* Stream.runForEach(outputStream, (value) => {
          const json = JSON.stringify(value);
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
          const render = (entry: StorePost) => {
            const doc = includeStoreLabel
              ? Doc.hsep([Doc.text(`[${entry.store.name}]`), renderPostCompact(entry.post)])
              : renderPostCompact(entry.post);
            return ansi ? renderAnsi(doc, w) : renderPlain(doc, w);
          };
          yield* Stream.runForEach(postStream, (entry) =>
            Ref.update(countRef, (count) => count + 1).pipe(
              Effect.zipRight(writeText(render(entry)))
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
          const rendered = postStream.pipe(
            Stream.map((entry) => {
              const lines = renderPostCard(entry.post);
              const doc = includeStoreLabel
                ? Doc.vsep([Doc.text(`[${entry.store.name}]`), ...lines])
                : Doc.vsep(lines);
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

      const collected = yield* Stream.runCollect(postStream);
      const entries = Chunk.toReadonlyArray(collected);
      const posts = entries.map((entry) => entry.post);
      const projectedPosts = entries.map(toOutput);
      yield* warnIfScanLimitReached();

      switch (outputFormat) {
        case "markdown":
          yield* writeText(
            includeStoreLabel
              ? renderStorePostsMarkdown(entries.map((entry) => ({
                  store: entry.store.name,
                  post: entry.post
                })))
              : renderPostsMarkdown(posts)
          );
          return;
        case "table":
          yield* writeText(
            includeStoreLabel
              ? renderStorePostsTable(entries.map((entry) => ({
                  store: entry.store.name,
                  post: entry.post
                })))
              : renderPostsTable(posts)
          );
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
        "skygent query my-store --filter 'contains:ai' --count",
        "skygent query my-store --filter 'has:images' --extract-images --resolve-images --format ndjson",
        "skygent query store-a,store-b --format ndjson"
      ],
      [
        "Tip: use --fields @minimal or --compact to reduce JSON output size."
      ]
    )
  )
);

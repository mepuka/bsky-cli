import { Args, Options } from "@effect/cli";
import { Effect, Option, Schema } from "effect";
import { ActorId, AtUri, PostUri, StoreName } from "../domain/primitives.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { CliInputError } from "./errors.js";
import { formatSchemaError } from "./shared.js";
import { NonNegativeInt, PositiveInt } from "./option-schemas.js";

/** --store option with StoreName schema validation */
export const storeNameOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name (positional or --store)"),
  Options.optional
);

/** Positional store name (optional when --store is provided) */
export const storeNameArg = Args.text({ name: "store" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Store name"),
  Args.optional
);

/** --filter DSL option (optional) */
export const filterOption = Options.text("filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);

/** --filter-json option (optional) */
export const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
  Options.optional
);

/** --post-filter DSL option (optional) */
export const postFilterOption = Options.text("post-filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);

/** --post-filter-json option (optional) */
export const postFilterJsonOption = Options.text("post-filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
  Options.optional
);

/** --filter-help flag to show DSL help */
export const filterHelpOption = Options.boolean("filter-help").pipe(
  Options.withDescription("Show filter DSL and JSON help")
);

/** --quiet flag to suppress progress output */
export const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);

/** --refresh flag to update existing posts instead of deduping */
export const refreshOption = Options.boolean("refresh").pipe(
  Options.withDescription("Refresh existing posts instead of deduping")
);

/** --cache-images flag to fetch image embeds after sync/watch */
export const cacheImagesOption = Options.boolean("cache-images").pipe(
  Options.withDescription("Fetch and cache image embeds after sync/watch")
);

/** --dry-run flag to preview changes without writing */
export const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview changes without writing to disk")
);

export const cacheImagesModeValues = ["new", "full"] as const;
export type CacheImagesMode = typeof cacheImagesModeValues[number];

export const cacheImagesModeOption = Options.choice(
  "cache-images-mode",
  cacheImagesModeValues
).pipe(
  Options.withDescription("Cache images for new posts only (new) or full store scan (full)"),
  Options.optional
);

export const cacheImagesLimitOption = Options.integer("cache-images-limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of posts to scan when caching images"),
  Options.optional
);

export const noCacheImagesThumbnailsOption = Options.boolean(
  "no-cache-images-thumbnails"
).pipe(
  Options.withDescription("Disable thumbnail caching when caching images")
);

/** --strict flag to stop on first error */
export const strictOption = Options.boolean("strict").pipe(
  Options.withDescription("Stop on first error and do not advance the checkpoint")
);

/** --max-errors option (optional) */
export const maxErrorsOption = Options.integer("max-errors").pipe(
  Options.withSchema(NonNegativeInt),
  Options.withDescription("Stop after exceeding N errors (default: unlimited)"),
  Options.optional
);

/** Positional arg for feed URI */
export const feedUriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(AtUri),
  Args.withDescription("Bluesky feed URI (at://...)")
);

/** Positional arg for list URI */
export const listUriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(AtUri),
  Args.withDescription("Bluesky list URI (at://...)")
);

/** Positional arg for author handle or DID */
export const actorArg = Args.text({ name: "actor" }).pipe(
  Args.withSchema(ActorId),
  Args.withDescription("Bluesky handle or DID")
);

/** Positional arg for post URI */
export const postUriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(PostUri),
  Args.withDescription("Bluesky post URI (at://...)")
);

export const authorFeedFilterValues = [
  "posts_with_replies",
  "posts_no_replies",
  "posts_with_media",
  "posts_and_author_threads"
] as const;

/** --filter option for author feed API (optional) */
export const authorFilterOption = Options.choice(
  "filter",
  authorFeedFilterValues
).pipe(
  Options.withDescription(
    "Author feed filter (posts_with_replies, posts_no_replies, posts_with_media, posts_and_author_threads)"
  ),
  Options.optional
);

/** --include-pins flag for author feed API */
export const includePinsOption = Options.boolean("include-pins").pipe(
  Options.withDescription("Include pinned posts in author feeds")
);

/** Validate --max-errors value is non-negative */
export const decodeActor = (actor: string) =>
  Schema.decodeUnknown(ActorId)(actor).pipe(
    Effect.mapError((error) =>
      CliInputError.make({
        message: `Invalid actor: ${formatSchemaError(error)}`,
        cause: { actor }
      })
    )
  );

export const resolveStoreName = (
  storeArg: Option.Option<StoreName>,
  storeOption: Option.Option<StoreName>
) =>
  Option.match(storeArg, {
    onNone: () =>
      Option.match(storeOption, {
        onNone: () =>
          Effect.fail(CliInputError.make({
            message: "Provide a store name as positional <store> or with --store.",
            cause: { storeArg: null, storeOption: null }
          })),
        onSome: (store) => Effect.succeed(store)
      }),
    onSome: (argValue) =>
      Option.match(storeOption, {
        onNone: () => Effect.succeed(argValue),
        onSome: (optionValue) =>
          optionValue === argValue
            ? Effect.succeed(optionValue)
            : Effect.fail(CliInputError.make({
                message: "Use either positional <store> or --store, not both.",
                cause: { storeArg: argValue, storeOption: optionValue }
              }))
      })
  });

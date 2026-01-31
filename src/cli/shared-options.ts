import { Args, Options } from "@effect/cli";
import { Effect, Option, Schema } from "effect";
import { AtUri, Did, Handle, PostUri, StoreName } from "../domain/primitives.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { CliInputError } from "./errors.js";
import { formatSchemaError } from "./shared.js";

/** --store option with StoreName schema validation */
export const storeNameOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to write into")
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

/** --quiet flag to suppress progress output */
export const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);

/** --refresh flag to update existing posts instead of deduping */
export const refreshOption = Options.boolean("refresh").pipe(
  Options.withDescription("Refresh existing posts instead of deduping")
);

/** --strict flag to stop on first error */
export const strictOption = Options.boolean("strict").pipe(
  Options.withDescription("Stop on first error and do not advance the checkpoint")
);

/** --max-errors option (optional) */
export const maxErrorsOption = Options.integer("max-errors").pipe(
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
export const parseMaxErrors = (maxErrors: Option.Option<number>) =>
  Option.match(maxErrors, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (value) =>
      value < 0
        ? Effect.fail(
            CliInputError.make({
              message: "max-errors must be a non-negative integer.",
              cause: value
            })
          )
        : Effect.succeed(Option.some(value))
  });

export const decodeActor = (actor: string) => {
  if (actor.startsWith("did:")) {
    return Schema.decodeUnknown(Did)(actor).pipe(
      Effect.mapError((error) =>
        CliInputError.make({
          message: `Invalid DID: ${formatSchemaError(error)}`,
          cause: { actor }
        })
      )
    );
  }
  return Schema.decodeUnknown(Handle)(actor).pipe(
    Effect.mapError((error) =>
      CliInputError.make({
        message: `Invalid handle: ${formatSchemaError(error)}`,
        cause: { actor }
      })
    )
  );
};

export const parseLimit = (limit: Option.Option<number>) =>
  Option.match(limit, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (value) =>
      value <= 0
        ? Effect.fail(
            CliInputError.make({
              message: "--limit must be a positive integer.",
              cause: value
            })
          )
        : Effect.succeed(Option.some(value))
  });

export const parseBoundedIntOption = (
  value: Option.Option<number>,
  name: string,
  min: number,
  max: number
) =>
  Option.match(value, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) =>
      raw < min || raw > max
        ? Effect.fail(
            CliInputError.make({
              message: `${name} must be between ${min} and ${max}.`,
              cause: raw
            })
          )
        : Effect.succeed(Option.some(raw))
  });

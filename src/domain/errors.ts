import { Schema } from "effect";
import { StoreName, StorePath } from "./primitives.js";

export class FilterCompileError extends Schema.TaggedError<FilterCompileError>()(
  "FilterCompileError",
  { message: Schema.String }
) {}

export class FilterEvalError extends Schema.TaggedError<FilterEvalError>()(
  "FilterEvalError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export class BskyError extends Schema.TaggedError<BskyError>()(
  "BskyError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class StoreNotFound extends Schema.TaggedError<StoreNotFound>()(
  "StoreNotFound",
  { name: StoreName }
) {}

export class StoreIoError extends Schema.TaggedError<StoreIoError>()(
  "StoreIoError",
  { path: StorePath, cause: Schema.Unknown }
) {}

export class StoreIndexError extends Schema.TaggedError<StoreIndexError>()(
  "StoreIndexError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export type StoreError = StoreNotFound | StoreIoError | StoreIndexError;

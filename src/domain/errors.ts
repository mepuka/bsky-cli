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
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
    operation: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
    error: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String)
  }
) {}

export class ImageFetchError extends Schema.TaggedError<ImageFetchError>()(
  "ImageFetchError",
  {
    message: Schema.String,
    url: Schema.String,
    cause: Schema.optional(Schema.Unknown),
    operation: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number)
  }
) {}
export const isImageFetchError = Schema.is(ImageFetchError);

export class ImageArchiveError extends Schema.TaggedError<ImageArchiveError>()(
  "ImageArchiveError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    operation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {}
export const isImageArchiveError = Schema.is(ImageArchiveError);

export class ImageCacheError extends Schema.TaggedError<ImageCacheError>()(
  "ImageCacheError",
  {
    message: Schema.String,
    key: Schema.String,
    operation: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number)
  }
) {}
export const isImageCacheError = Schema.is(ImageCacheError);

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export class StoreNotFound extends Schema.TaggedError<StoreNotFound>()(
  "StoreNotFound",
  {
    name: StoreName,
    message: Schema.optionalWith(Schema.String, {
      default: () => "Store not found"
    })
  }
) {}

export class StoreAlreadyExists extends Schema.TaggedError<StoreAlreadyExists>()(
  "StoreAlreadyExists",
  {
    name: StoreName,
    message: Schema.optionalWith(Schema.String, {
      default: () => "Store already exists"
    })
  }
) {}

export class StoreIoError extends Schema.TaggedError<StoreIoError>()(
  "StoreIoError",
  { path: StorePath, cause: Schema.Unknown }
) {}
export const isStoreIoError = Schema.is(StoreIoError);

export class StoreIndexError extends Schema.TaggedError<StoreIndexError>()(
  "StoreIndexError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export class StoreSourcesError extends Schema.TaggedError<StoreSourcesError>()(
  "StoreSourcesError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown), operation: Schema.optional(Schema.String) }
) {}
export const isStoreSourcesError = Schema.is(StoreSourcesError);


export class FilterNotFound extends Schema.TaggedError<FilterNotFound>()(
  "FilterNotFound",
  {
    name: Schema.String,
    message: Schema.optionalWith(Schema.String, {
      default: () => "Filter not found"
    })
  }
) {}

export class FilterLibraryError extends Schema.TaggedError<FilterLibraryError>()(
  "FilterLibraryError",
  {
    message: Schema.String,
    name: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

export type StoreError = StoreNotFound | StoreAlreadyExists | StoreIoError | StoreIndexError | StoreSourcesError;

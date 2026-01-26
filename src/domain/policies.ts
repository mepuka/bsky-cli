import { Schema } from "effect";

export class IncludeOnError extends Schema.TaggedClass<IncludeOnError>()("Include", {}) {}
export class ExcludeOnError extends Schema.TaggedClass<ExcludeOnError>()("Exclude", {}) {}

export class RetryOnError extends Schema.TaggedClass<RetryOnError>()("Retry", {
  maxRetries: Schema.NonNegativeInt,
  baseDelay: Schema.Duration
}) {}

export const FilterErrorPolicy = Schema.Union(
  IncludeOnError,
  ExcludeOnError,
  RetryOnError
);
export type FilterErrorPolicy = typeof FilterErrorPolicy.Type;

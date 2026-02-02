import { Schema } from "effect";
import { StoreName, Timestamp } from "./primitives.js";

const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

export const AnalyticsBucketUnit = Schema.Literal("hour", "day");
export type AnalyticsBucketUnit = typeof AnalyticsBucketUnit.Type;

export const AnalyticsMetricKey = Schema.Literal(
  "posts",
  "authors",
  "likes",
  "reposts",
  "replies",
  "quotes",
  "engagement"
);
export type AnalyticsMetricKey = typeof AnalyticsMetricKey.Type;

export class AnalyticsBucket extends Schema.Class<AnalyticsBucket>("AnalyticsBucket")({
  bucket: Schema.String,
  posts: Schema.optional(NonNegativeInt),
  authors: Schema.optional(NonNegativeInt),
  likes: Schema.optional(NonNegativeInt),
  reposts: Schema.optional(NonNegativeInt),
  replies: Schema.optional(NonNegativeInt),
  quotes: Schema.optional(NonNegativeInt),
  engagement: Schema.optional(NonNegativeInt)
}) {}

export class AnalyticsRange extends Schema.Class<AnalyticsRange>("AnalyticsRange")({
  start: Timestamp,
  end: Timestamp
}) {}

export class AnalyticsSeries extends Schema.Class<AnalyticsSeries>("AnalyticsSeries")({
  store: StoreName,
  unit: AnalyticsBucketUnit,
  metrics: Schema.Array(AnalyticsMetricKey),
  range: Schema.optional(AnalyticsRange),
  buckets: Schema.Array(AnalyticsBucket)
}) {}

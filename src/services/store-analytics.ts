import { Effect, Schema } from "effect";
import { AnalyticsBucket, AnalyticsRange, AnalyticsSeries, type AnalyticsBucketUnit, type AnalyticsMetricKey } from "../domain/analytics.js";
import type { StoreRef } from "../domain/store.js";
import { Timestamp, type StorePath } from "../domain/primitives.js";
import { StoreIoError, isStoreIoError } from "../domain/errors.js";
import { StoreDb } from "./store-db.js";

type AnalyticsRangeInput = {
  readonly start: Date;
  readonly end: Date;
};

type AnalyticsInput = {
  readonly unit: AnalyticsBucketUnit;
  readonly metrics: ReadonlyArray<AnalyticsMetricKey>;
  readonly range?: AnalyticsRangeInput;
};

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toStoreIoError = (path: StorePath) => (cause: unknown) => {
  if (isStoreIoError(cause)) {
    return cause;
  }
  return StoreIoError.make({ path, cause });
};

const parseCount = (value: unknown) =>
  typeof value === "number" ? value : Number(value ?? 0);

export class StoreAnalytics extends Effect.Service<StoreAnalytics>()("@skygent/StoreAnalytics", {
  effect: Effect.gen(function* () {
    const storeDb = yield* StoreDb;

    const timeBuckets = Effect.fn("StoreAnalytics.timeBuckets")(
      (store: StoreRef, input: AnalyticsInput) =>
        storeDb.withClient(store, (client) =>
          Effect.gen(function* () {
            const unit = input.unit;
            const range = input.range;
            const bucketExpr =
              unit === "day"
                ? client`created_date`
                : client`substr(created_at, 1, 13) || ':00:00Z'`;
            const whereClause = range
              ? client`WHERE created_at >= ${toIso(range.start)} AND created_at <= ${toIso(range.end)}`
              : client``;

            const rows = yield* client`SELECT
                ${bucketExpr} as bucket,
                COUNT(*) as posts,
                COUNT(DISTINCT author) as authors,
                SUM(like_count) as likes,
                SUM(repost_count) as reposts,
                SUM(reply_count) as replies,
                SUM(quote_count) as quotes,
                SUM(like_count + (repost_count * 2) + (reply_count * 3) + (quote_count * 2)) as engagement
              FROM posts
              ${whereClause}
              GROUP BY bucket
              ORDER BY bucket ASC`.pipe(
                Effect.mapError(toStoreIoError(store.root))
              );

            const decoded = yield* Schema.decodeUnknown(
              Schema.Array(
                Schema.Struct({
                  bucket: Schema.String,
                  posts: Schema.Unknown,
                  authors: Schema.Unknown,
                  likes: Schema.Unknown,
                  reposts: Schema.Unknown,
                  replies: Schema.Unknown,
                  quotes: Schema.Unknown,
                  engagement: Schema.Unknown
                })
              )
            )(rows).pipe(Effect.mapError(toStoreIoError(store.root)));

            const selected = new Set(input.metrics);
            const buckets = decoded
              .map((row) => {
                const bucket = row.bucket;
                const posts = parseCount(row.posts);
                const authors = parseCount(row.authors);
                const likes = parseCount(row.likes);
                const reposts = parseCount(row.reposts);
                const replies = parseCount(row.replies);
                const quotes = parseCount(row.quotes);
                const engagement = parseCount(row.engagement);

                return AnalyticsBucket.make({
                  bucket,
                  ...(selected.has("posts") ? { posts } : {}),
                  ...(selected.has("authors") ? { authors } : {}),
                  ...(selected.has("likes") ? { likes } : {}),
                  ...(selected.has("reposts") ? { reposts } : {}),
                  ...(selected.has("replies") ? { replies } : {}),
                  ...(selected.has("quotes") ? { quotes } : {}),
                  ...(selected.has("engagement") ? { engagement } : {})
                });
              })
              .filter((row) => row.bucket.length > 0);

            const rangeValue = input.range
              ? AnalyticsRange.make({
                  start: yield* Schema.decodeUnknown(Timestamp)(input.range.start).pipe(
                    Effect.mapError(toStoreIoError(store.root))
                  ),
                  end: yield* Schema.decodeUnknown(Timestamp)(input.range.end).pipe(
                    Effect.mapError(toStoreIoError(store.root))
                  )
                })
              : undefined;

            return AnalyticsSeries.make({
              store: store.name,
              unit,
              metrics: input.metrics,
              ...(rangeValue ? { range: rangeValue } : {}),
              buckets
            });
          })
        )
    );

    return { timeBuckets };
  })
}) {
  static readonly layer = StoreAnalytics.Default;
}

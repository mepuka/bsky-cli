/**
 * Trending Topics Service
 *
 * Provides functionality to check if hashtags are trending on Bluesky.
 * Uses the Bluesky API to fetch trending topics and caches results for 15 minutes
 * to reduce API calls and improve performance.
 *
 * This service is primarily used by the Trending filter to determine if posts
 * contain hashtags that are currently trending.
 *
 * @module services/trending-topics
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { TrendingTopics } from "./services/trending-topics.js";
 * import { Hashtag } from "./domain/primitives.js";
 *
 * const program = Effect.gen(function* () {
 *   const trending = yield* TrendingTopics;
 *
 *   // Get all trending topics
 *   const topics = yield* trending.getTopics();
 *   console.log("Trending topics:", topics);
 *
 *   // Check if a specific hashtag is trending
 *   const isTrending = yield* trending.isTrending(Hashtag.make("effect"));
 *   console.log("Is #effect trending?", isTrending);
 * });
 * ```
 */

import * as KeyValueStore from "@effect/platform/KeyValueStore";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Schema
} from "effect";
import { FilterEvalError } from "../domain/errors.js";
import { Hashtag } from "../domain/primitives.js";
import { BskyClient } from "./bsky-client.js";

/** Cache key prefix for trending topics storage */
const cachePrefix = "cache/trending/";

/** Cache key for storing trending topics */
const cacheKey = "topics";

/** Cache TTL - trending topics are cached for 15 minutes */
const cacheTtl = Duration.minutes(15);

/**
 * Converts an error to a FilterEvalError with the given message.
 * @param message - Error message describing the failure context
 * @returns A function that takes a cause and creates a FilterEvalError
 */
const toFilterEvalError = (message: string) => (cause: unknown) =>
  FilterEvalError.make({ message, cause });

/**
 * Normalizes a topic string for comparison by trimming whitespace,
 * converting to lowercase, and removing the leading '#' if present.
 * @param topic - The topic string to normalize
 * @returns Normalized topic string
 * @example
 * ```ts
 * normalizeTopic("#Effect") // returns "effect"
 * normalizeTopic("  BSKY  ") // returns "bsky"
 * ```
 */
const normalizeTopic = (topic: string) =>
  topic.trim().toLowerCase().replace(/^#/, "");

/**
 * Schema for cached trending topics data.
 * Stores the list of topics and when they were fetched.
 */
class TrendingCacheEntry extends Schema.Class<TrendingCacheEntry>("TrendingCacheEntry")({
  /** Array of trending topic strings */
  topics: Schema.Array(Schema.String),
  /** Timestamp when the cache entry was created */
  checkedAt: Schema.DateFromString
}) {}

/**
 * Interface for the Trending Topics service.
 * Provides methods to fetch and check trending topics on Bluesky.
 */
export type TrendingTopicsService = {
  /**
   * Fetches the current trending topics from Bluesky.
   * Uses a 15-minute cache to avoid excessive API calls.
   * @returns An Effect that resolves to an array of trending topic strings
   * @throws {FilterEvalError} If fetching topics fails
   */
  readonly getTopics: () => Effect.Effect<ReadonlyArray<string>, FilterEvalError>;

  /**
   * Checks if a specific hashtag is currently trending.
   * @param tag - The hashtag to check
   * @returns An Effect that resolves to true if the hashtag is trending, false otherwise
   * @throws {FilterEvalError} If checking trending status fails
   * @example
   * ```ts
   * const isTrending = yield* trending.isTrending(Hashtag.make("typescript"));
   * ```
   */
  readonly isTrending: (tag: Hashtag) => Effect.Effect<boolean, FilterEvalError>;
};

/**
 * Effect Context Tag for the Trending Topics service.
 * Provides trending topic functionality with caching for Bluesky hashtags.
 *
 * @example
 * ```ts
 * // Use in an Effect program
 * const program = Effect.gen(function* () {
 *   const trending = yield* TrendingTopics;
 *   const topics = yield* trending.getTopics();
 * });
 *
 * // Provide the layer
 * const runnable = program.pipe(Effect.provide(TrendingTopics.layer));
 * ```
 */
export class TrendingTopics extends Effect.Service<TrendingTopics>()("@skygent/TrendingTopics", {
  effect: Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const bsky = yield* BskyClient;
    const store = KeyValueStore.prefix(
      kv.forSchema(TrendingCacheEntry),
      cachePrefix
    );

    /**
     * Fetches trending topics from Bluesky API.
     * Wrapped with error mapping for consistent error handling.
     */
    const fetchTopics = bsky.getTrendingTopics().pipe(
      Effect.mapError(toFilterEvalError("Trending topics fetch failed"))
    );

    /**
     * Checks if a cache entry is still fresh (within TTL).
     * @param entry - The cached trending topics entry
     * @param now - Current timestamp in milliseconds
     * @returns True if the entry is still fresh
     */
    const isFresh = (entry: TrendingCacheEntry, now: number) =>
      now - entry.checkedAt.getTime() < Duration.toMillis(cacheTtl);

    /**
     * Gets trending topics, using cache if available and fresh.
     * Fetches fresh data if cache is expired or missing.
     */
    const getTopics = Effect.fn("TrendingTopics.getTopics")(() =>
      Effect.gen(function* () {
        const cached = yield* store
          .get(cacheKey)
          .pipe(Effect.mapError(toFilterEvalError("Trending cache read failed")));

        const now = yield* Clock.currentTimeMillis;
        if (Option.isSome(cached) && isFresh(cached.value, now)) {
          return cached.value.topics;
        }

        const topics = yield* fetchTopics;
        const entry = TrendingCacheEntry.make({
          topics,
          checkedAt: new Date(now)
        });
        yield* store
          .set(cacheKey, entry)
          .pipe(Effect.mapError(toFilterEvalError("Trending cache write failed")));

        return topics;
      })
    );

    /**
     * Checks if a specific hashtag is in the trending topics list.
     * Uses normalized comparison for case-insensitive matching.
     */
    const isTrending = Effect.fn("TrendingTopics.isTrending")((tag: Hashtag) =>
      getTopics().pipe(
        Effect.map((topics) =>
          topics.includes(normalizeTopic(String(tag)))
        )
      )
    );

    return { getTopics, isTrending };
  })
}) {
  static readonly layer = TrendingTopics.Default;

  /**
   * Test layer with mock trending topics for testing.
   * Returns static data: ["effect", "bsky"]
   */
  static readonly testLayer = Layer.succeed(
    TrendingTopics,
    TrendingTopics.make({
      getTopics: () => Effect.succeed(["effect", "bsky"]),
      isTrending: (tag) =>
        Effect.succeed(["effect", "bsky"].includes(normalizeTopic(String(tag))))
    })
  );
}

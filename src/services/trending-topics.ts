import { AtpAgent } from "@atproto/api";
import type { AppBskyUnspeccedGetTrendingTopics } from "@atproto/api";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema
} from "effect";
import { FilterEvalError } from "../domain/errors.js";
import { Hashtag } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";
import { CredentialStore } from "./credential-store.js";

const cachePrefix = "cache/trending/";
const cacheKey = "topics";
const cacheTtl = Duration.minutes(15);

const toFilterEvalError = (message: string) => (cause: unknown) =>
  FilterEvalError.make({ message, cause });

const normalizeTopic = (topic: string) =>
  topic.trim().toLowerCase().replace(/^#/, "");

class TrendingCacheEntry extends Schema.Class<TrendingCacheEntry>("TrendingCacheEntry")({
  topics: Schema.Array(Schema.String),
  checkedAt: Schema.DateFromString
}) {}

export type TrendingTopicsService = {
  readonly getTopics: () => Effect.Effect<ReadonlyArray<string>, FilterEvalError>;
  readonly isTrending: (tag: Hashtag) => Effect.Effect<boolean, FilterEvalError>;
};

export class TrendingTopics extends Context.Tag("@skygent/TrendingTopics")<
  TrendingTopics,
  TrendingTopicsService
>() {
  static readonly layer = Layer.effect(
    TrendingTopics,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const config = yield* AppConfigService;
      const credentials = yield* CredentialStore;
      const store = KeyValueStore.prefix(
        kv.forSchema(TrendingCacheEntry),
        cachePrefix
      );
      const agent = new AtpAgent({ service: config.service });

      const withViewer = <T extends Record<string, unknown>>(
        params: T,
        viewer: string | undefined
      ): T & { viewer?: string } =>
        viewer ? { ...params, viewer } : params;

      const ensureAuth = Effect.gen(function* () {
        if (agent.hasSession) {
          return;
        }
        const creds = yield* credentials
          .get()
          .pipe(Effect.mapError(toFilterEvalError("Failed to load credentials")));
        if (Option.isNone(creds)) {
          return;
        }
        const value = creds.value;
        yield* Effect.tryPromise(() =>
          agent.login({
            identifier: value.identifier,
            password: Redacted.value(value.password)
          })
        ).pipe(Effect.mapError(toFilterEvalError("Bluesky login failed")));
      });

      const fetchTopics = Effect.gen(function* () {
        yield* ensureAuth;
        const response = yield* Effect.tryPromise<
          AppBskyUnspeccedGetTrendingTopics.Response
        >(() =>
          agent.app.bsky.unspecced.getTrendingTopics(
            withViewer({ limit: 25 }, agent.did ?? undefined)
          )
        ).pipe(Effect.mapError(toFilterEvalError("Trending topics fetch failed")));

        const topics = [
          ...response.data.topics,
          ...response.data.suggested
        ]
          .map((topic) => normalizeTopic(topic.topic))
          .filter((topic) => topic.length > 0);

        return Array.from(new Set(topics));
      });

      const isFresh = (entry: TrendingCacheEntry, now: number) =>
        now - entry.checkedAt.getTime() < Duration.toMillis(cacheTtl);

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

      const isTrending = Effect.fn("TrendingTopics.isTrending")((tag: Hashtag) =>
        getTopics().pipe(
          Effect.map((topics) =>
            topics.includes(normalizeTopic(String(tag)))
          )
        )
      );

      return TrendingTopics.of({ getTopics, isTrending });
    })
  );

  static readonly testLayer = Layer.succeed(
    TrendingTopics,
    TrendingTopics.of({
      getTopics: () => Effect.succeed(["effect", "bsky"]),
      isTrending: (tag) =>
        Effect.succeed(["effect", "bsky"].includes(normalizeTopic(String(tag))))
    })
  );
}

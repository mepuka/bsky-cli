import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Stream } from "effect";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService } from "../../src/services/app-config.js";
import { BskyClient } from "../../src/services/bsky-client.js";
import { CredentialStore } from "../../src/services/credential-store.js";
import { makeBskyMockLayer } from "../support/bsky-mock-server.js";
import timelineFixture from "../fixtures/bsky/timeline.json";
import feedFixture from "../fixtures/bsky/feed.json";
import notificationsFixture from "../fixtures/bsky/notifications.json";
import authorFeedFixture from "../fixtures/bsky/author-feed.json";
import threadFixture from "../fixtures/bsky/thread.json";
import threadNotFoundFixture from "../fixtures/bsky/thread-not-found.json";
import negativeMetricsFixture from "../fixtures/bsky/timeline-negative-metrics.json";

describe("BskyClient", () => {
  test("fetches timeline posts from mock server", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        const collected = yield* Stream.runCollect(client.getTimeline());
        return Chunk.toReadonlyArray(collected);
      }).pipe(Effect.provide(layer))
    );

    const posts = await Effect.runPromise(program);
    expect(posts.length).toBe(2);
    expect(String(posts[0]?.author)).toBe("alice.bsky");
    expect(String(posts[0]?.authorProfile?.handle)).toBe("alice.bsky");
  });

  test("fetches feed and notifications", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        const feed = yield* Stream.runCollect(client.getFeed("at://feed/example"));
        const notifications = yield* Stream.runCollect(client.getNotifications());
        return {
          feed: Chunk.toReadonlyArray(feed),
          notifications: Chunk.toReadonlyArray(notifications)
        };
      }).pipe(Effect.provide(layer))
    );

    const result = await Effect.runPromise(program);
    expect(result.feed.length).toBe(1);
    expect(result.notifications.length).toBe(1);
  });

  test("fetches author feed posts", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        const collected = yield* Stream.runCollect(
          client.getAuthorFeed("alice.bsky")
        );
        return Chunk.toReadonlyArray(collected);
      }).pipe(Effect.provide(layer))
    );

    const posts = await Effect.runPromise(program);
    expect(posts.length).toBe(2);
    expect(String(posts[0]?.author)).toBe("alice.bsky");
  });

  test("fetches and flattens post threads", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getPostThread(
          "at://did:plc:root/app.bsky.feed.post/100"
        );
      }).pipe(Effect.provide(layer))
    );

    const posts = await Effect.runPromise(program);
    const uris = posts.map((post) => String(post.uri));
    expect(uris).toEqual([
      "at://did:plc:root/app.bsky.feed.post/100",
      "at://did:plc:parent/app.bsky.feed.post/99",
      "at://did:plc:reply/app.bsky.feed.post/101"
    ]);
  });

  test("returns empty list for not-found threads", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadNotFoundFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getPostThread(
          "at://did:plc:missing/app.bsky.feed.post/404"
        );
      }).pipe(Effect.provide(layer))
    );

    const posts = await Effect.runPromise(program);
    expect(posts.length).toBe(0);
  });

  test("handles -1 metric sentinel values", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: negativeMetricsFixture,
        feed: feedFixture,
        notifications: notificationsFixture,
        authorFeed: authorFeedFixture,
        postThread: threadFixture
      })
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
    const layer = Layer.mergeAll(baseLayer, appConfigLayer, credentialLayer, bskyLayer);

    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        const collected = yield* Stream.runCollect(client.getTimeline());
        return Chunk.toReadonlyArray(collected);
      }).pipe(Effect.provide(layer))
    );

    const posts = await Effect.runPromise(program);
    expect(posts.length).toBe(1);
    // -1 values coerced to undefined, valid values preserved
    expect(posts[0]?.metrics?.quoteCount).toBeUndefined();
    expect(posts[0]?.metrics?.replyCount).toBe(5);
    expect(posts[0]?.metrics?.likeCount).toBeUndefined();
  });
});

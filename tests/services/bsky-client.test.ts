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

describe("BskyClient", () => {
  test("fetches timeline posts from mock server", async () => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        timeline: timelineFixture,
        feed: feedFixture,
        notifications: notificationsFixture
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
        notifications: notificationsFixture
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
});

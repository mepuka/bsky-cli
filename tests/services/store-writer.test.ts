import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreWriter } from "../../src/services/store-writer.js";
import { EventMeta, PostEventRecord, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";
import { storePrefix } from "../../src/services/store-keys.js";

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #effect",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#effect"],
  mentions: [],
  links: []
});

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const sampleEvent = PostUpsert.make({ post: samplePost, meta: sampleMeta });
const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "arsenal",
  root: "/tmp/arsenal"
});

const testLayer = StoreWriter.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

describe("StoreWriter", () => {
  test("append writes event record to KV store", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const kv = yield* KeyValueStore.KeyValueStore;

      const record = yield* writer.append(sampleStore, sampleEvent);
      const key = `events/${record.event.meta.source}/${record.id}`;
      const storeEvents = KeyValueStore.prefix(
        kv.forSchema(PostEventRecord),
        storePrefix(sampleStore)
      );
      const stored = yield* storeEvents.get(key);

      return { record, stored };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result.stored)).toBe(true);
    if (Option.isSome(result.stored)) {
      expect(result.stored.value).toEqual(result.record);
    }
  });
});

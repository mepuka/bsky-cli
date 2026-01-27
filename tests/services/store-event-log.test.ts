import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";
import { EventId } from "../../src/domain/primitives.js";
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

const testLayer = Layer.mergeAll(
  StoreEventLog.layer,
  StoreWriter.layer
).pipe(Layer.provideMerge(KeyValueStore.layerMemory));

describe("StoreEventLog", () => {
  test("getLastEventId returns None when no events", async () => {
    const program = Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      const lastId = yield* eventLog.getLastEventId(sampleStore);
      return lastId;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isNone(result)).toBe(true);
  });

  test("getLastEventId returns last event ID after append", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      const record = yield* writer.append(sampleStore, sampleEvent);
      const lastId = yield* eventLog.getLastEventId(sampleStore);

      return { record, lastId };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result.lastId)).toBe(true);
    if (Option.isSome(result.lastId)) {
      expect(result.lastId.value).toEqual(result.record.id);
    }
  });

  test("getLastEventId returns last event ID after multiple appends", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      const record1 = yield* writer.append(sampleStore, sampleEvent);
      const record2 = yield* writer.append(sampleStore, sampleEvent);
      const record3 = yield* writer.append(sampleStore, sampleEvent);
      const lastId = yield* eventLog.getLastEventId(sampleStore);

      return { record1, record2, record3, lastId };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result.lastId)).toBe(true);
    if (Option.isSome(result.lastId)) {
      expect(result.lastId.value).toEqual(result.record3.id);
    }
  });

  test("clear removes last event ID", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      yield* writer.append(sampleStore, sampleEvent);
      yield* writer.append(sampleStore, sampleEvent);

      const lastIdBefore = yield* eventLog.getLastEventId(sampleStore);
      yield* eventLog.clear(sampleStore);
      const lastIdAfter = yield* eventLog.getLastEventId(sampleStore);

      return { lastIdBefore, lastIdAfter };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result.lastIdBefore)).toBe(true);
    expect(Option.isNone(result.lastIdAfter)).toBe(true);
  });

  test("clear ignores missing manifest in filesystem stores", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const fsLayer = StoreEventLog.layer.pipe(
      Layer.provideMerge(KeyValueStore.layerFileSystem(tempDir)),
      Layer.provideMerge(BunContext.layer)
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const eventLog = yield* StoreEventLog;
          yield* eventLog.clear(sampleStore);
        }).pipe(Effect.provide(fsLayer))
      );
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(tempDir, { recursive: true });
        }).pipe(Effect.provide(BunContext.layer))
      );
    }
  });
});

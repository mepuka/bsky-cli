import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

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
  root: "stores/arsenal"
});

const makeTempDir = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory();
    }).pipe(Effect.provide(BunContext.layer))
  );

const removeTempDir = (path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true });
    }).pipe(Effect.provide(BunContext.layer))
  );

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    writerLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreEventLog", () => {
  test("getLastEventSeq returns None when no events", async () => {
    const program = Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      return yield* eventLog.getLastEventSeq(sampleStore);
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("getLastEventSeq returns last event seq after append", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      const entry = yield* writer.append(sampleStore, sampleEvent);
      const lastSeq = yield* eventLog.getLastEventSeq(sampleStore);

      return { entry, lastSeq };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result.lastSeq)).toBe(true);
      if (Option.isSome(result.lastSeq)) {
        expect(result.lastSeq.value).toEqual(result.entry.seq);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("getLastEventSeq returns last event seq after multiple appends", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      const entry1 = yield* writer.append(sampleStore, sampleEvent);
      const entry2 = yield* writer.append(sampleStore, sampleEvent);
      const entry3 = yield* writer.append(sampleStore, sampleEvent);
      const lastSeq = yield* eventLog.getLastEventSeq(sampleStore);

      return { entry1, entry2, entry3, lastSeq };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result.lastSeq)).toBe(true);
      if (Option.isSome(result.lastSeq)) {
        expect(result.lastSeq.value).toEqual(result.entry3.seq);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("clear removes last event seq", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const eventLog = yield* StoreEventLog;

      yield* writer.append(sampleStore, sampleEvent);
      yield* writer.append(sampleStore, sampleEvent);

      const lastSeqBefore = yield* eventLog.getLastEventSeq(sampleStore);
      yield* eventLog.clear(sampleStore);
      const lastSeqAfter = yield* eventLog.getLastEventSeq(sampleStore);

      return { lastSeqBefore, lastSeqAfter };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result.lastSeqBefore)).toBe(true);
      expect(Option.isNone(result.lastSeqAfter)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("clear on empty store does not fail", async () => {
    const program = Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      yield* eventLog.clear(sampleStore);
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      await Effect.runPromise(program.pipe(Effect.provide(layer)));
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

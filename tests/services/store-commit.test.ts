import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreCommitter } from "../../src/services/store-commit.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { EventMeta, PostDelete, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

const makePost = (id: number) =>
  Schema.decodeUnknownSync(Post)({
    uri: `at://did:plc:example/app.bsky.feed.post/${id}`,
    author: "alice.bsky",
    text: `Post #${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    hashtags: [],
    mentions: [],
    links: []
  });

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const makeEvent = (id: number) =>
  PostUpsert.make({ post: makePost(id), meta: sampleMeta });

const storeA = Schema.decodeUnknownSync(StoreRef)({
  name: "store-a",
  root: "stores/store-a"
});

const storeB = Schema.decodeUnknownSync(StoreRef)({
  name: "store-b",
  root: "stores/store-b"
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
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const committerLayer = StoreCommitter.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(writerLayer)
  );

  return Layer.mergeAll(appConfigLayer, storeDbLayer, writerLayer, committerLayer).pipe(
    Layer.provideMerge(BunContext.layer)
  );
};

describe("StoreCommitter", () => {
  test("concurrent upserts to same store produce correct results", async () => {
    const program = Effect.gen(function* () {
      const committer = yield* StoreCommitter;

      const entries = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => makeEvent(i)),
        (event) => committer.appendUpsert(storeA, event),
        { concurrency: "unbounded" }
      );

      return entries;
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const entries = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(entries.length).toBe(10);
      const ids = entries.map((e) => e.record.id);
      expect(new Set(ids).size).toBe(10);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("concurrent upserts to different stores both succeed", async () => {
    const program = Effect.gen(function* () {
      const committer = yield* StoreCommitter;

      const [entriesA, entriesB] = yield* Effect.all(
        [
          Effect.forEach(
            Array.from({ length: 5 }, (_, i) => makeEvent(i)),
            (event) => committer.appendUpsert(storeA, event),
            { concurrency: "unbounded" }
          ),
          Effect.forEach(
            Array.from({ length: 5 }, (_, i) => makeEvent(100 + i)),
            (event) => committer.appendUpsert(storeB, event),
            { concurrency: "unbounded" }
          )
        ],
        { concurrency: "unbounded" }
      );

      return { entriesA, entriesB };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.entriesA.length).toBe(5);
      expect(result.entriesB.length).toBe(5);

      const idsA = result.entriesA.map((e) => e.record.id);
      const idsB = result.entriesB.map((e) => e.record.id);
      expect(new Set(idsA).size).toBe(5);
      expect(new Set(idsB).size).toBe(5);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("appendUpsertIfMissing deduplicates correctly", async () => {
    const sharedEvent = makeEvent(42);

    const program = Effect.gen(function* () {
      const committer = yield* StoreCommitter;

      const results = yield* Effect.forEach(
        Array.from({ length: 10 }),
        () => committer.appendUpsertIfMissing(storeA, sharedEvent),
        { concurrency: "unbounded" }
      );

      return results;
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const results = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      const inserted = results.filter(Option.isSome);
      const skipped = results.filter(Option.isNone);

      expect(inserted.length).toBe(1);
      expect(skipped.length).toBe(9);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("appendDeletes batches delete events in a single operation", async () => {
    const upsert = makeEvent(77);
    const deleteEvent = PostDelete.make({
      uri: upsert.post.uri,
      meta: sampleMeta
    });

    const program = Effect.gen(function* () {
      const committer = yield* StoreCommitter;
      const storeDb = yield* StoreDb;

      yield* committer.appendUpsert(storeA, upsert);
      const deleted = yield* committer.appendDeletes(storeA, [deleteEvent, deleteEvent]);
      const rows = yield* storeDb.withClient(storeA, (client) =>
        client`SELECT COUNT(*) as count FROM posts`
      );
      return {
        deletedCount: deleted.length,
        postCount: Number(rows[0]?.count ?? 0)
      };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.deletedCount).toBe(2);
      expect(result.postCount).toBe(0);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

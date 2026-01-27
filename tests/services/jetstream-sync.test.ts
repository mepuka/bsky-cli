import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Jetstream, JetstreamMessage } from "effect-jetstream";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { LlmDecision } from "../../src/services/llm.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { PostParser } from "../../src/services/post-parser.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { SyncCheckpointStore } from "../../src/services/sync-checkpoint-store.js";
import { SyncReporter } from "../../src/services/sync-reporter.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";
import { JetstreamSyncEngine } from "../../src/services/jetstream-sync.js";
import { ProfileResolver } from "../../src/services/profile-resolver.js";
import { all, filterExprSignature, none } from "../../src/domain/filter.js";
import { Handle, Timestamp } from "../../src/domain/primitives.js";
import { StoreRef } from "../../src/domain/store.js";
import { DataSource } from "../../src/domain/sync.js";

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "jetstream-store",
  root: "stores/jetstream-store"
});

const sampleHandle = Schema.decodeUnknownSync(Handle)("alice.bsky");

const commitCreate = Schema.decodeUnknownSync(JetstreamMessage.CommitCreate)({
  _tag: "CommitCreate",
  did: "did:plc:alice",
  time_us: 1_000_000,
  kind: "commit",
  commit: {
    rev: "1",
    operation: "create",
    collection: "app.bsky.feed.post",
    rkey: "1",
    record: {
      $type: "app.bsky.feed.post",
      text: "Hello #jetstream",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  }
});

const commitUpdate = Schema.decodeUnknownSync(JetstreamMessage.CommitUpdate)({
  _tag: "CommitUpdate",
  did: "did:plc:alice",
  time_us: 2_000_000,
  kind: "commit",
  commit: {
    rev: "2",
    operation: "update",
    collection: "app.bsky.feed.post",
    rkey: "1",
    record: {
      $type: "app.bsky.feed.post",
      text: "Updated #jetstream",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  }
});

const commitDelete = Schema.decodeUnknownSync(JetstreamMessage.CommitDelete)({
  _tag: "CommitDelete",
  did: "did:plc:alice",
  time_us: 3_000_000,
  kind: "commit",
  commit: {
    rev: "3",
    operation: "delete",
    collection: "app.bsky.feed.post",
    rkey: "1"
  }
});

const commitCreateDuplicate = Schema.decodeUnknownSync(JetstreamMessage.CommitCreate)({
  _tag: "CommitCreate",
  did: "did:plc:alice",
  time_us: 2_000_000,
  kind: "commit",
  commit: {
    rev: "2",
    operation: "create",
    collection: "app.bsky.feed.post",
    rkey: "1",
    record: {
      $type: "app.bsky.feed.post",
      text: "Hello #jetstream again",
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  }
});

const commitInvalid = Schema.decodeUnknownSync(JetstreamMessage.CommitCreate)({
  _tag: "CommitCreate",
  did: "did:plc:alice",
  time_us: 4_000_000,
  kind: "commit",
  commit: {
    rev: "4",
    operation: "create",
    collection: "app.bsky.feed.post",
    rkey: "2",
    record: {
      $type: "app.bsky.feed.post",
      text: 123,
      createdAt: "not-a-date"
    }
  }
});

const makeJetstreamLayer = (stream: Stream.Stream<JetstreamMessage.JetstreamMessage>) =>
  Layer.succeed(Jetstream.Jetstream, {
    [Jetstream.TypeId]: Jetstream.TypeId,
    stream,
    send: () => Effect.void,
    updateOptions: () => Effect.void
  });

const profileLayer = Layer.succeed(
  ProfileResolver,
  ProfileResolver.of({
    handleForDid: () => Effect.succeed(sampleHandle)
  })
);

const filterRuntimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(LlmDecision.testLayer),
  Layer.provideMerge(LinkValidator.testLayer),
  Layer.provideMerge(TrendingTopics.testLayer)
);

const makeTestLayer = (stream: Stream.Stream<JetstreamMessage.JetstreamMessage>) =>
  JetstreamSyncEngine.layer.pipe(
    Layer.provideMerge(makeJetstreamLayer(stream)),
    Layer.provideMerge(profileLayer),
    Layer.provideMerge(PostParser.layer),
    Layer.provideMerge(filterRuntimeLayer),
    Layer.provideMerge(StoreWriter.layer),
    Layer.provideMerge(StoreIndex.layer),
    Layer.provideMerge(StoreEventLog.layer),
    Layer.provideMerge(SyncCheckpointStore.layer),
    Layer.provideMerge(SyncReporter.layer),
    Layer.provideMerge(KeyValueStore.layerMemory)
  );

describe("JetstreamSyncEngine", () => {
  test("sync processes commit create/update/delete and saves checkpoint", async () => {
    const filter = all();
    const filterHash = filterExprSignature(filter);
    const source = DataSource.jetstream() as Extract<DataSource, { _tag: "Jetstream" }>;

    const program = Effect.gen(function* () {
      const engine = yield* JetstreamSyncEngine;
      const index = yield* StoreIndex;
      const checkpoints = yield* SyncCheckpointStore;

      const result = yield* engine.sync({
        source,
        store: sampleStore,
        filter,
        command: "sync jetstream",
        limit: 3
      });

      const count = yield* index.count(sampleStore);
      const checkpoint = yield* checkpoints.load(sampleStore, source);

      return { result, count, checkpoint };
    });

    const outcome = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeTestLayer(Stream.fromIterable([commitCreate, commitUpdate, commitDelete]))
        )
      )
    );

    expect(outcome.result.postsAdded).toBe(3);
    expect(outcome.result.postsSkipped).toBe(0);
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.count).toBe(0);
    expect(Option.isSome(outcome.checkpoint)).toBe(true);
    if (Option.isSome(outcome.checkpoint)) {
      const value = outcome.checkpoint.value;
      const updatedAt = Schema.decodeUnknownSync(Timestamp)(value.updatedAt);
      expect(updatedAt).toBeInstanceOf(Date);
      expect(value.cursor).toBe("3000000");
      expect(value.filterHash).toBe(filterHash);
    }
  });

  test("skips posts when filter excludes all", async () => {
    const filter = none();
    const source = DataSource.jetstream() as Extract<DataSource, { _tag: "Jetstream" }>;

    const program = Effect.gen(function* () {
      const engine = yield* JetstreamSyncEngine;
      const index = yield* StoreIndex;
      const result = yield* engine.sync({
        source,
        store: sampleStore,
        filter,
        command: "sync jetstream",
        limit: 1
      });
      const count = yield* index.count(sampleStore);
      return { result, count };
    });

    const outcome = await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(Stream.fromIterable([commitCreate]))))
    );

    expect(outcome.result.postsAdded).toBe(0);
    expect(outcome.result.postsSkipped).toBe(1);
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.count).toBe(0);
  });

  test("deduplicates repeated commit create events", async () => {
    const filter = all();
    const source = DataSource.jetstream() as Extract<DataSource, { _tag: "Jetstream" }>;

    const program = Effect.gen(function* () {
      const engine = yield* JetstreamSyncEngine;
      const index = yield* StoreIndex;
      const result = yield* engine.sync({
        source,
        store: sampleStore,
        filter,
        command: "sync jetstream",
        limit: 2
      });
      const count = yield* index.count(sampleStore);
      return { result, count };
    });

    const outcome = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          makeTestLayer(Stream.fromIterable([commitCreate, commitCreateDuplicate]))
        )
      )
    );

    expect(outcome.result.postsAdded).toBe(1);
    expect(outcome.result.postsSkipped).toBe(1);
    expect(outcome.result.errors).toEqual([]);
    expect(outcome.count).toBe(1);
  });

  test("strict mode stops on first error and does not save checkpoint", async () => {
    const filter = all();
    const source = DataSource.jetstream() as Extract<DataSource, { _tag: "Jetstream" }>;

    const program = Effect.gen(function* () {
      const engine = yield* JetstreamSyncEngine;
      const checkpoints = yield* SyncCheckpointStore;
      const outcome = yield* engine
        .sync({
          source,
          store: sampleStore,
          filter,
          command: "sync jetstream",
          limit: 1,
          strict: true
        })
        .pipe(Effect.either);
      const checkpoint = yield* checkpoints.load(sampleStore, source);
      return { outcome, checkpoint };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(Stream.fromIterable([commitInvalid]))))
    );

    expect(result.outcome._tag).toBe("Left");
    expect(Option.isNone(result.checkpoint)).toBe(true);
  });

  test("max-errors stops after threshold is exceeded", async () => {
    const filter = all();
    const source = DataSource.jetstream() as Extract<DataSource, { _tag: "Jetstream" }>;

    const program = Effect.gen(function* () {
      const engine = yield* JetstreamSyncEngine;
      return yield* engine
        .sync({
          source,
          store: sampleStore,
          filter,
          command: "sync jetstream",
          limit: 2,
          maxErrors: 0
        })
        .pipe(Effect.either);
    });

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(makeTestLayer(Stream.fromIterable([commitInvalid, commitInvalid])))
      )
    );

    expect(result._tag).toBe("Left");
  });
});

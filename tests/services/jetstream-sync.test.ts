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
import { all, filterExprSignature } from "../../src/domain/filter.js";
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

const jetstreamService = {
  [Jetstream.TypeId]: Jetstream.TypeId,
  stream: Stream.fromIterable([commitCreate, commitUpdate, commitDelete]),
  send: () => Effect.void,
  updateOptions: () => Effect.void
};

const jetstreamLayer = Layer.succeed(Jetstream.Jetstream, jetstreamService);
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

const testLayer = JetstreamSyncEngine.layer.pipe(
  Layer.provideMerge(jetstreamLayer),
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

    const outcome = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

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
});

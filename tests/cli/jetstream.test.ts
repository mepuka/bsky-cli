import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { buildJetstreamSelection } from "../../src/cli/jetstream.js";
import { SyncCheckpoint } from "../../src/domain/sync.js";
import { StoreRef } from "../../src/domain/store.js";
import { SyncCheckpointStore } from "../../src/services/sync-checkpoint-store.js";
import { Timestamp } from "../../src/domain/primitives.js";
import { all, filterExprSignature } from "../../src/domain/filter.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "jetstream-store",
  root: "stores/jetstream-store"
});

const filterHash = filterExprSignature(all());

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
  const checkpointLayer = SyncCheckpointStore.layer.pipe(
    Layer.provideMerge(storeDbLayer)
  );
  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    checkpointLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

const withLayer = async <A>(program: Effect.Effect<A>) => {
  const tempDir = await makeTempDir();
  const layer = buildLayer(tempDir);
  try {
    return await Effect.runPromise(program.pipe(Effect.provide(layer)));
  } finally {
    await removeTempDir(tempDir);
  }
};

describe("buildJetstreamSelection", () => {
  test("prefers explicit cursor over checkpoint", async () => {
    const program = Effect.gen(function* () {
      const checkpoints = yield* SyncCheckpointStore;
      const updatedAt = Schema.decodeUnknownSync(Timestamp)(new Date().toISOString());
      yield* checkpoints.save(
        sampleStore,
        SyncCheckpoint.make({
          source: (yield* buildJetstreamSelection(
            {
              endpoint: Option.some("wss://example"),
              collections: Option.some("app.bsky.feed.post"),
              dids: Option.some("did:plc:one"),
              cursor: Option.some("111"),
              compress: false,
              maxMessageSize: Option.none()
            },
            sampleStore,
            filterHash
          )).source,
          cursor: "111",
          filterHash,
          updatedAt
        })
      );

      return yield* buildJetstreamSelection(
        {
          endpoint: Option.some("wss://example"),
          collections: Option.some("app.bsky.feed.post"),
          dids: Option.some("did:plc:one"),
          cursor: Option.some("222"),
          compress: false,
          maxMessageSize: Option.none()
        },
        sampleStore,
        filterHash
      );
    });

    const selection = await withLayer(program);

    expect(selection.cursor).toBe("222");
    expect(selection.config.cursor).toBe(222);
  });

  test("uses checkpoint cursor when no explicit cursor provided", async () => {
    const program = Effect.gen(function* () {
      const checkpoints = yield* SyncCheckpointStore;
      const updatedAt = Schema.decodeUnknownSync(Timestamp)(new Date().toISOString());
      yield* checkpoints.save(
        sampleStore,
        SyncCheckpoint.make({
          source: (yield* buildJetstreamSelection(
            {
              endpoint: Option.some("wss://example"),
              collections: Option.some("app.bsky.feed.post"),
              dids: Option.some("did:plc:one"),
              cursor: Option.none(),
              compress: false,
              maxMessageSize: Option.none()
            },
            sampleStore,
            filterHash
          )).source,
          cursor: "333",
          filterHash,
          updatedAt
        })
      );

      return yield* buildJetstreamSelection(
        {
          endpoint: Option.some("wss://example"),
          collections: Option.some("app.bsky.feed.post"),
          dids: Option.some("did:plc:one"),
          cursor: Option.none(),
          compress: false,
          maxMessageSize: Option.none()
        },
        sampleStore,
        filterHash
      );
    });

    const selection = await withLayer(program);

    expect(selection.cursor).toBe("333");
    expect(selection.config.cursor).toBe(333);
  });

  test("fails when collections include unsupported values", async () => {
    const program = buildJetstreamSelection(
      {
        endpoint: Option.some("wss://example"),
        collections: Option.some("app.bsky.feed.post,app.bsky.feed.like"),
        dids: Option.none(),
        cursor: Option.none(),
        compress: false,
        maxMessageSize: Option.none()
      },
      sampleStore,
      filterHash
    );

    const result = await withLayer(program.pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CliInputError");
    }
  });

  test("rejects invalid cursor values", async () => {
    const program = buildJetstreamSelection(
      {
        endpoint: Option.some("wss://example"),
        collections: Option.some("app.bsky.feed.post"),
        dids: Option.none(),
        cursor: Option.some("-1"),
        compress: false,
        maxMessageSize: Option.none()
      },
      sampleStore,
      filterHash
    );

    const result = await withLayer(program.pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CliInputError");
    }
  });

  test("rejects invalid max-message-size", async () => {
    const program = buildJetstreamSelection(
      {
        endpoint: Option.some("wss://example"),
        collections: Option.some("app.bsky.feed.post"),
        dids: Option.none(),
        cursor: Option.none(),
        compress: false,
        maxMessageSize: Option.some(0)
      },
      sampleStore,
      filterHash
    );

    const result = await withLayer(program.pipe(Effect.either));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left._tag).toBe("CliInputError");
    }
  });
});

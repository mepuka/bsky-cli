import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Layer, Ref, Schema, Sink, Stream } from "effect";
import { digestCommand } from "../../src/cli/digest.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreDb } from "../../src/services/store-db.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { StoreName } from "../../src/domain/primitives.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";

const ensureNewline = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

const decodeChunk = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

const makeOutputCapture = () => {
  const stdoutRef = Ref.unsafeMake<ReadonlyArray<string>>([]);
  const stderrRef = Ref.unsafeMake<ReadonlyArray<string>>([]);

  const append = (ref: Ref.Ref<ReadonlyArray<string>>, chunk: string | Uint8Array) =>
    Ref.update(ref, (items) => [...items, decodeChunk(chunk)]);

  const stdoutSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stdoutRef, chunk)
  );
  const stderrSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stderrRef, chunk)
  );

  const writeJson = (value: unknown, pretty?: boolean) =>
    append(
      stdoutRef,
      ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0))
    );

  const writeText = (value: string) =>
    append(stdoutRef, ensureNewline(value));

  const writeJsonStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.map((value) => `${JSON.stringify(value)}\n`),
      Stream.run(stdoutSink)
    );

  const writeStderr = (value: string) =>
    append(stderrRef, ensureNewline(value));

  const service: CliOutputService = {
    stdout: stdoutSink,
    stderr: stderrSink,
    writeJson,
    writeText,
    writeJsonStream,
    writeStderr
  };

  const layer = Layer.succeed(CliOutput, CliOutput.of(service));

  return { layer, stdoutRef, stderrRef };
};

const makeAppConfigLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  return AppConfigService.layer.pipe(Layer.provide(overrides));
};

const testLayers = (storeRoot: string) => {
  const appConfigLayer = makeAppConfigLayer(storeRoot);
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );

  return Layer.mergeAll(
    managerLayer,
    writerLayer,
    indexLayer,
    eventLogLayer,
    storeDbLayer,
    appConfigLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #ai",
  createdAt: "2026-01-01T00:10:00.000Z",
  hashtags: ["#ai"],
  mentions: [],
  links: [],
  metrics: { likeCount: 10, repostCount: 2, replyCount: 1, quoteCount: 0 }
});

const samplePostLater = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/2",
  author: "bob.bsky",
  text: "Later post #tech",
  createdAt: "2026-01-01T12:00:00.000Z",
  hashtags: ["#tech"],
  mentions: [],
  links: [],
  metrics: { likeCount: 1, repostCount: 0, replyCount: 0, quoteCount: 0 }
});

describe("digest command", () => {
  test("summarizes a store for a range", async () => {
    const run = Command.run(digestCommand, { name: "skygent", version: "0.0.0" });
    const { layer: outputLayer, stdoutRef } = makeOutputCapture();
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );
    const appLayer = Layer.mergeAll(outputLayer, testLayers(tempDir));

    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;

      const name = Schema.decodeUnknownSync(StoreName)("digest-store");
      const store = yield* manager.createStore(name, defaultStoreConfig);

      const record1 = yield* writer.append(
        store,
        PostUpsert.make({ post: samplePost, meta: sampleMeta })
      );
      const record2 = yield* writer.append(
        store,
        PostUpsert.make({ post: samplePostLater, meta: sampleMeta })
      );
      yield* index.apply(store, record1.record);
      yield* index.apply(store, record2.record);

      return yield* run([
        "node",
        "skygent",
        "digest-store",
        "--range",
        "2026-01-01T00:00:00Z..2026-01-02T00:00:00Z"
      ]);
    });

    await Effect.runPromise(program.pipe(Effect.provide(appLayer)));

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const payload = JSON.parse(stdout.join("").trim());
    expect(payload.store).toBe("digest-store");
    expect(payload.posts.total).toBe(2);
    expect(payload.authors.total).toBe(2);
    expect(payload.hashtags[0]).toMatchObject({ tag: "#ai", count: 1 });
    expect(payload.topPosts[0]).toMatchObject({ uri: samplePost.uri });
    expect(payload.volume.unit).toBe("hour");
  });
});

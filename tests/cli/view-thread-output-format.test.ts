import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { FileSystem } from "@effect/platform";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref, Schema, Sink, Stream } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { threadCommand } from "../../src/cli/view-thread.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreConfig } from "../../src/domain/store.js";
import { EventMeta, PostEventRecord, PostUpsert } from "../../src/domain/events.js";
import { EventId, StoreName } from "../../src/domain/primitives.js";
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
    append(stdoutRef, ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0)));

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

  return { layer, stdoutRef };
};

const sampleConfig = Schema.decodeUnknownSync(StoreConfig)({
  format: { json: true, markdown: false },
  autoSync: false,
  filters: []
});

const makePost = (uri: string, author: string, createdAt: string) =>
  Schema.decodeUnknownSync(Post)({
    uri,
    author,
    text: `Post ${uri}`,
    createdAt,
    hashtags: [],
    mentions: [],
    links: []
  });

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const eventId = (value: string) => Schema.decodeUnknownSync(EventId)(value);

const makeRecord = (post: Post, id: string) =>
  PostEventRecord.make({
    id: eventId(id),
    version: 1,
    event: PostUpsert.make({ post, meta: sampleMeta })
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
  const overrides = Layer.succeed(ConfigOverrides, {
    storeRoot,
    outputFormat: "json"
  });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("view thread output format defaults", () => {
  test("uses config output format when --format is omitted", async () => {
    const run = Command.run(threadCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { layer: outputLayer, stdoutRef } = makeOutputCapture();
    const appLayer = Layer.mergeAll(outputLayer, buildLayer(tempDir));

    const post = makePost(
      "at://did:plc:example/app.bsky.feed.post/1",
      "alice.bsky.social",
      "2026-01-01T00:00:00.000Z"
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;
          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAV"));

          yield* run([
            "node",
            "skygent",
            post.uri,
            "--store",
            "alpha"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = JSON.parse(stdout.join("").trim()) as unknown;
      expect(Array.isArray(payload)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

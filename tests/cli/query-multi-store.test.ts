import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Ref, Sink, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { queryCommand } from "../../src/cli/query.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { CliPreferences } from "../../src/cli/preferences.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { StoreConfig } from "../../src/domain/store.js";
import { EventMeta, PostEventRecord, PostUpsert } from "../../src/domain/events.js";
import { EventId, StoreName } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";
import { Schema } from "effect";

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

const makePostWithMetrics = (
  uri: string,
  author: string,
  createdAt: string,
  metrics: { likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }
) =>
  Schema.decodeUnknownSync(Post)({
    uri,
    author,
    text: `Post ${uri}`,
    createdAt,
    hashtags: [],
    mentions: [],
    links: [],
    metrics
  });

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const eventId = (value: string) => Schema.decodeUnknownSync(EventId)(value);

const postA = makePost(
  "at://did:plc:example/app.bsky.feed.post/1",
  "alice.bsky",
  "2026-01-01T00:00:00.000Z"
);
const postB = makePost(
  "at://did:plc:example/app.bsky.feed.post/2",
  "bob.bsky",
  "2026-01-02T00:00:00.000Z"
);
const postC = makePost(
  "at://did:plc:example/app.bsky.feed.post/3",
  "claire.bsky",
  "2026-01-03T00:00:00.000Z"
);

const makeRecord = (post: Post, id: string) =>
  PostEventRecord.make({
    id: eventId(id),
    version: 1,
    event: PostUpsert.make({ post, meta: sampleMeta })
  });

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

  return { layer, stdoutRef, stderrRef };
};

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const filterRuntimeLayer = Layer.succeed(
    FilterRuntime,
    FilterRuntime.of({
      evaluate: () => Effect.succeed(() => Effect.succeed(true)),
      evaluateWithMetadata: () => Effect.succeed(() => Effect.succeed({ ok: true })),
      evaluateBatch: () =>
        Effect.succeed((posts) => Effect.succeed(Chunk.map(posts, () => true))),
      explain: () => Effect.succeed(() => Effect.succeed({ ok: true, reasons: [] }))
    })
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer,
    filterRuntimeLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

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

const setupAppLayer = (storeRoot: string) => {
  const { layer: outputLayer, stdoutRef, stderrRef } = makeOutputCapture();
  const appLayer = Layer.mergeAll(
    outputLayer,
    Layer.succeed(CliPreferences, { compact: false }),
    buildLayer(storeRoot)
  );
  return { appLayer, stdoutRef, stderrRef };
};

const parseNdjson = (stdout: ReadonlyArray<string>) =>
  stdout
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { store?: string; post?: { uri: string } });

describe("query multi-store", () => {
  test("merges ordered results and includes store name", async () => {
    const run = Command.run(queryCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const storeA = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          const storeB = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("bravo"),
            sampleConfig
          );

          yield* index.apply(storeA, makeRecord(postA, "01ARZ3NDEKTSV4RRFFQ69G5FAV"));
          yield* index.apply(storeB, makeRecord(postB, "01ARZ3NDEKTSV4RRFFQ69G5FAW"));
          yield* index.apply(storeA, makeRecord(postC, "01ARZ3NDEKTSV4RRFFQ69G5FAX"));

          yield* run(["node", "skygent", "alpha,bravo", "--format", "ndjson"]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const items = parseNdjson(stdout);

      expect(items.length).toBe(3);
      expect(items[0]?.store).toBe("alpha");
      expect(items[0]?.post?.uri).toBe(postA.uri);
      expect(items[1]?.store).toBe("bravo");
      expect(items[1]?.post?.uri).toBe(postB.uri);
      expect(items[2]?.store).toBe("alpha");
      expect(items[2]?.post?.uri).toBe(postC.uri);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("sorts by engagement across stores", async () => {
    const run = Command.run(queryCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir);

    const postHigh = makePostWithMetrics(
      "at://did:plc:example/app.bsky.feed.post/101",
      "alpha.bsky",
      "2026-01-01T00:00:00.000Z",
      { replyCount: 3, quoteCount: 1 }
    );
    const postMid = makePostWithMetrics(
      "at://did:plc:example/app.bsky.feed.post/102",
      "beta.bsky",
      "2026-01-02T00:00:00.000Z",
      { repostCount: 2 }
    );
    const postLow = makePostWithMetrics(
      "at://did:plc:example/app.bsky.feed.post/103",
      "gamma.bsky",
      "2026-01-03T00:00:00.000Z",
      { likeCount: 2 }
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const storeA = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          const storeB = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("beta"),
            sampleConfig
          );

          yield* index.apply(storeA, makeRecord(postHigh, "01ARZ3NDEKTSV4RRFFQ69G5FAW"));
          yield* index.apply(storeB, makeRecord(postMid, "01ARZ3NDEKTSV4RRFFQ69G5FAX"));
          yield* index.apply(storeB, makeRecord(postLow, "01ARZ3NDEKTSV4RRFFQ69G5FAY"));

          yield* run(["node", "skygent", "alpha,beta", "--format", "ndjson", "--sort", "by-engagement"]);
        }).pipe(Effect.provide(appLayer))
      );

      const results = parseNdjson(await Effect.runPromise(Ref.get(stdoutRef)));
      const uris = results.map((row) => row.post?.uri).filter((uri): uri is string => uri !== undefined);
      expect(uris).toEqual([postHigh.uri, postMid.uri, postLow.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("orders by uri before store when timestamps match", async () => {
    const run = Command.run(queryCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const storeA = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          const storeB = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("bravo"),
            sampleConfig
          );

          const sharedTime = "2026-01-04T00:00:00.000Z";
          const alphaPost = makePost(
            "at://did:plc:example/app.bsky.feed.post/2",
            "alpha.bsky",
            sharedTime
          );
          const bravoPost = makePost(
            "at://did:plc:example/app.bsky.feed.post/1",
            "bravo.bsky",
            sharedTime
          );

          yield* index.apply(
            storeA,
            makeRecord(alphaPost, "01ARZ3NDEKTSV4RRFFQ69G5FBA")
          );
          yield* index.apply(
            storeB,
            makeRecord(bravoPost, "01ARZ3NDEKTSV4RRFFQ69G5FBB")
          );

          yield* run(["node", "skygent", "alpha,bravo", "--format", "ndjson"]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const items = parseNdjson(stdout);

      expect(items.length).toBe(2);
      expect(items[0]?.store).toBe("bravo");
      expect(items[0]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/1");
      expect(items[1]?.store).toBe("alpha");
      expect(items[1]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/2");
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("applies limit after merge", async () => {
    const run = Command.run(queryCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const storeA = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          const storeB = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("bravo"),
            sampleConfig
          );

          const post1 = makePost(
            "at://did:plc:example/app.bsky.feed.post/10",
            "alpha.bsky",
            "2026-01-01T00:00:00.000Z"
          );
          const post2 = makePost(
            "at://did:plc:example/app.bsky.feed.post/20",
            "bravo.bsky",
            "2026-01-02T00:00:00.000Z"
          );
          const post3 = makePost(
            "at://did:plc:example/app.bsky.feed.post/30",
            "alpha.bsky",
            "2026-01-03T00:00:00.000Z"
          );

          yield* index.apply(storeA, makeRecord(post1, "01ARZ3NDEKTSV4RRFFQ69G5FBC"));
          yield* index.apply(storeB, makeRecord(post2, "01ARZ3NDEKTSV4RRFFQ69G5FBD"));
          yield* index.apply(storeA, makeRecord(post3, "01ARZ3NDEKTSV4RRFFQ69G5FBE"));

          yield* run([
            "node",
            "skygent",
            "alpha,bravo",
            "--format",
            "ndjson",
            "--limit",
            "2"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const items = parseNdjson(stdout);

      expect(items.length).toBe(2);
      expect(items[0]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/10");
      expect(items[1]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/20");
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("applies scan limit per store", async () => {
    const run = Command.run(queryCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const storeA = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("alpha"),
            sampleConfig
          );
          const storeB = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("bravo"),
            sampleConfig
          );

          const post1 = makePost(
            "at://did:plc:example/app.bsky.feed.post/40",
            "alpha.bsky",
            "2026-01-01T00:00:00.000Z"
          );
          const post2 = makePost(
            "at://did:plc:example/app.bsky.feed.post/50",
            "alpha.bsky",
            "2026-01-03T00:00:00.000Z"
          );
          const post3 = makePost(
            "at://did:plc:example/app.bsky.feed.post/41",
            "bravo.bsky",
            "2026-01-02T00:00:00.000Z"
          );
          const post4 = makePost(
            "at://did:plc:example/app.bsky.feed.post/51",
            "bravo.bsky",
            "2026-01-04T00:00:00.000Z"
          );

          yield* index.apply(storeA, makeRecord(post1, "01ARZ3NDEKTSV4RRFFQ69G5FBF"));
          yield* index.apply(storeA, makeRecord(post2, "01ARZ3NDEKTSV4RRFFQ69G5FBG"));
          yield* index.apply(storeB, makeRecord(post3, "01ARZ3NDEKTSV4RRFFQ69G5FBH"));
          yield* index.apply(storeB, makeRecord(post4, "01ARZ3NDEKTSV4RRFFQ69G5FBJ"));

          yield* run([
            "node",
            "skygent",
            "alpha,bravo",
            "--format",
            "ndjson",
            "--scan-limit",
            "1"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const items = parseNdjson(stdout);

      expect(items.length).toBe(2);
      expect(items[0]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/40");
      expect(items[1]?.post?.uri).toBe("at://did:plc:example/app.bsky.feed.post/41");
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Chunk, Effect, Layer, Schema } from "effect";
import { OutputManager } from "../../src/services/output-manager.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreDb } from "../../src/services/store-db.js";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { FilterCompiler } from "../../src/services/filter-compiler.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { LlmDecision } from "../../src/services/llm.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { FilterOutput, FilterSpec, StoreConfig } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #tech",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#tech"],
  mentions: [],
  links: []
});

const otherPost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/2",
  author: "bob.bsky",
  text: "Other topic",
  createdAt: "2026-01-02T00:00:00.000Z",
  hashtags: ["#other"],
  mentions: [],
  links: []
});

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storageLayer = KeyValueStore.layerMemory;
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const runtimeLayer = FilterRuntime.layer.pipe(
    Layer.provideMerge(LlmDecision.testLayer),
    Layer.provideMerge(LinkValidator.testLayer),
    Layer.provideMerge(TrendingTopics.testLayer)
  );
  const outputLayer = OutputManager.layer.pipe(
    Layer.provideMerge(appConfigLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(FilterCompiler.layer)
  );
  const baseLayer = Layer.mergeAll(
    appConfigLayer,
    storageLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    writerLayer,
    managerLayer,
    runtimeLayer,
    FilterCompiler.layer,
    outputLayer
  );

  return baseLayer.pipe(Layer.provideMerge(BunContext.layer));
};

describe("OutputManager", () => {
  test("materializes filter outputs to disk", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const config = StoreConfig.make({
      format: { json: true, markdown: true },
      autoSync: false,
      filters: [
        FilterSpec.make({
          name: "tech",
          expr: { _tag: "Hashtag", tag: "#tech" },
          output: FilterOutput.make({
            path: "views/filters/tech",
            json: true,
            markdown: true
          })
        })
      ]
    });

    const layer = buildLayer(tempDir);

    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const output = yield* OutputManager;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const storeName = Schema.decodeUnknownSync(StoreName)("mystore");
      const storeRef = yield* manager.createStore(storeName, config);

      const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
      const upsert2 = PostUpsert.make({ post: otherPost, meta: sampleMeta });

      const record1 = yield* writer.append(storeRef, upsert1);
      const record2 = yield* writer.append(storeRef, upsert2);
      yield* index.apply(storeRef, record1);
      yield* index.apply(storeRef, record2);

      const result = yield* output.materializeStore(storeRef);

      const outputDir = path.join(tempDir, storeRef.root, "views/filters/tech");
      const jsonPath = path.join(outputDir, "posts.json");
      const markdownPath = path.join(outputDir, "posts.md");
      const manifestPath = path.join(outputDir, "manifest.json");

      const jsonRaw = yield* fs.readFileString(jsonPath);
      const markdownRaw = yield* fs.readFileString(markdownPath);
      const manifestRaw = yield* fs.readFileString(manifestPath);

      return {
        result,
        json: JSON.parse(jsonRaw) as ReadonlyArray<{ uri: string }>,
        markdown: markdownRaw,
        manifest: JSON.parse(manifestRaw) as { count: number }
      };
    });

    const output = await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(output.result.filters.length).toBe(1);
    expect(output.json).toHaveLength(1);
    expect(output.json[0]?.uri).toBe(samplePost.uri);
    expect(output.markdown).toContain(samplePost.uri);
    expect(output.manifest.count).toBe(1);
  });
});

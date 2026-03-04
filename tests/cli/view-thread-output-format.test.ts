import { Command } from "@effect/cli";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { threadCommand } from "../../src/cli/view-thread.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreConfig } from "../../src/domain/store.js";
import { EventMeta, PostEventRecord, PostUpsert } from "../../src/domain/events.js";
import { EventId, StoreName } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";
import { makeOutputCapture, readStdout } from "../support/cli-output-capture.js";
import { buildCliTestLayer } from "../support/layers.js";
import { makeTempDir, removeTempDir } from "../support/temp-dir.js";

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

describe("view thread output format defaults", () => {
  test("uses config output format when --format is omitted", async () => {
    const run = Command.run(threadCommand, {
      name: "skygent",
      version: "0.0.0"
    });
    const tempDir = await makeTempDir();
    const { layer: outputLayer, stdoutRef } = makeOutputCapture();
    const appLayer = buildCliTestLayer({
      storeRoot: tempDir,
      outputLayer,
      appConfigOverrides: { outputFormat: "json" }
    });

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

      const stdout = await readStdout(stdoutRef);
      const payload = JSON.parse(stdout.trim()) as unknown;
      expect(Array.isArray(payload)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

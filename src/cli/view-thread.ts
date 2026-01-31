import { Args, Command, Options } from "@effect/cli";
import { Chunk, Console, Effect, Option, Stream } from "effect";
import { PostUri, StoreName } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import { all } from "../domain/filter.js";
import { StoreQuery } from "../domain/events.js";
import { DataSource } from "../domain/sync.js";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import { StoreIndex } from "../services/store-index.js";
import { SyncEngine } from "../services/sync-engine.js";
import { renderThread } from "./doc/thread.js";
import { renderPlain, renderAnsi } from "./doc/render.js";
import { writeJson, writeText } from "./output.js";
import { storeOptions } from "./store.js";
import { withExamples } from "./help.js";
import { CliInputError } from "./errors.js";
import {
  depthOption as threadDepthOption,
  parentHeightOption as threadParentHeightOption,
  parseThreadDepth
} from "./thread-options.js";
import { textJsonFormats } from "./output-format.js";
import { PositiveInt } from "./option-schemas.js";

const uriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(PostUri),
  Args.withDescription("AT-URI of any post in the thread")
);

const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Query from local store instead of API"),
  Options.optional
);

const compactOption = Options.boolean("compact").pipe(
  Options.withDescription("Single-line rendering (default: card)")
);

const ansiOption = Options.boolean("ansi").pipe(
  Options.withDescription("Enable ANSI colors in output")
);

const widthOption = Options.integer("width").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Line width for terminal output"),
  Options.optional
);

const formatOption = Options.choice("format", textJsonFormats).pipe(
  Options.withDescription("Output format (default: text)"),
  Options.optional
);

const depthOption = threadDepthOption("Reply depth (API only, default: 6)");
const parentHeightOption = threadParentHeightOption(
  "Parent height (API only, default: 80)"
);

export const threadCommand = Command.make(
  "thread",
  {
    uri: uriArg,
    store: storeOption,
    compact: compactOption,
    ansi: ansiOption,
    width: widthOption,
    format: formatOption,
    depth: depthOption,
    parentHeight: parentHeightOption
  },
  ({ uri, store, compact, ansi, width, format, depth, parentHeight }) =>
    Effect.gen(function* () {
      const outputFormat = Option.getOrElse(format, () => "text" as const);
      const w = Option.getOrUndefined(width);
      const { depth: depthValue, parentHeight: parentHeightValue } =
        parseThreadDepth(depth, parentHeight);
      const d = depthValue ?? 6;
      const ph = parentHeightValue ?? 80;

      let posts: ReadonlyArray<Post>;

      if (Option.isSome(store)) {
        const index = yield* StoreIndex;
        const storeRef = yield* storeOptions.loadStoreRef(store.value);
        const hasTarget = yield* index.hasUri(storeRef, uri);
        if (!hasTarget) {
          const engine = yield* SyncEngine;
          const source = DataSource.thread(uri, { depth: d, parentHeight: ph });
          yield* engine.sync(source, storeRef, all());
        }
        const query = StoreQuery.make({});
        const stream = index.query(storeRef, query);
        const collected = yield* Stream.runCollect(stream);
        const allPosts = Chunk.toReadonlyArray(collected);
        const threadPosts = selectThreadPosts(allPosts, String(uri));
        if (threadPosts.length === 0) {
          return yield* CliInputError.make({
            message: `Thread not found for ${uri}.`,
            cause: { uri, store: storeRef.name }
          });
        }
        // B1: Hint when only root post exists in store
        if (threadPosts.length === 1 && threadPosts[0]?.uri === uri) {
          yield* Console.log("\nℹ️  Only root post found in store. Use --no-store to fetch full thread from API.\n");
        }
        posts = threadPosts;
      } else {
        const client = yield* BskyClient;
        const parser = yield* PostParser;
        const rawPosts = yield* client.getPostThread(uri, { depth: d, parentHeight: ph });
        posts = yield* Effect.forEach(rawPosts, (raw) => parser.parsePost(raw));
      }

      if (outputFormat === "json") {
        yield* writeJson(posts);
        return;
      }

      const doc = renderThread(
        posts,
        w === undefined ? { compact } : { compact, lineWidth: w }
      );
      yield* writeText(ansi ? renderAnsi(doc, w) : renderPlain(doc, w));
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Display a thread from the API or a local store",
      [
        "skygent view thread at://did:plc:example/app.bsky.feed.post/xyz --ansi",
        "skygent view thread at://did:plc:example/app.bsky.feed.post/xyz --compact --ansi",
        "skygent view thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store --ansi --width 100",
        "skygent view thread at://did:plc:example/app.bsky.feed.post/xyz --format json"
      ]
    )
  )
);

const selectThreadPosts = (posts: ReadonlyArray<Post>, targetUri: string) => {
  const byUri = new Map(posts.map((post) => [String(post.uri), post]));
  if (!byUri.has(targetUri)) {
    return [] as ReadonlyArray<Post>;
  }

  const childMap = new Map<string, Post[]>();
  for (const post of posts) {
    const parentUri = post.reply?.parent?.uri ? String(post.reply.parent.uri) : undefined;
    if (!parentUri || !byUri.has(parentUri)) {
      continue;
    }
    const siblings = childMap.get(parentUri) ?? [];
    siblings.push(post);
    childMap.set(parentUri, siblings);
  }

  const threadUris = new Set<string>();
  let current: Post | undefined = byUri.get(targetUri);
  while (current) {
    const currentUri = String(current.uri);
    threadUris.add(currentUri);
    const parentUri = current.reply?.parent?.uri
      ? String(current.reply.parent.uri)
      : undefined;
    current = parentUri ? byUri.get(parentUri) : undefined;
  }

  const queue: Array<string> = [targetUri];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const children = childMap.get(next) ?? [];
    for (const child of children) {
      const childUri = String(child.uri);
      if (!threadUris.has(childUri)) {
        threadUris.add(childUri);
        queue.push(childUri);
      }
    }
  }

  return posts.filter((post) => threadUris.has(String(post.uri)));
};

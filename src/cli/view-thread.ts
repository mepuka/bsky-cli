import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option, Stream } from "effect";
import { StoreName } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import { StoreQuery } from "../domain/events.js";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import { StoreIndex } from "../services/store-index.js";
import { renderThread } from "./doc/thread.js";
import { renderPlain, renderAnsi } from "./doc/render.js";
import { writeJson, writeText } from "./output.js";
import { storeOptions } from "./store.js";
import { withExamples } from "./help.js";

const uriArg = Args.text({ name: "uri" }).pipe(
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
  Options.withDescription("Line width for terminal output"),
  Options.optional
);

const formatOption = Options.choice("format", ["text", "json"]).pipe(
  Options.withDescription("Output format (default: text)"),
  Options.optional
);

const depthOption = Options.integer("depth").pipe(
  Options.withDescription("Reply depth (API only, default: 6)"),
  Options.optional
);

const parentHeightOption = Options.integer("parent-height").pipe(
  Options.withDescription("Parent height (API only, default: 80)"),
  Options.optional
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

      let posts: ReadonlyArray<Post>;

      if (Option.isSome(store)) {
        const index = yield* StoreIndex;
        const storeRef = yield* storeOptions.loadStoreRef(store.value);
        const query = StoreQuery.make({});
        const stream = index.query(storeRef, query);
        const collected = yield* Stream.runCollect(stream);
        posts = Chunk.toReadonlyArray(collected);
      } else {
        const client = yield* BskyClient;
        const parser = yield* PostParser;
        const d = Option.getOrElse(depth, () => 6);
        const ph = Option.getOrElse(parentHeight, () => 80);
        const rawPosts = yield* client.getPostThread(uri, { depth: d, parentHeight: ph });
        posts = yield* Effect.forEach(rawPosts, (raw) => parser.parsePost(raw));
      }

      if (outputFormat === "json") {
        yield* writeJson(posts);
        return;
      }

      const doc = renderThread(posts, { compact });
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

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsTable } from "../domain/format.js";
import type { FeedGeneratorView, ProfileView } from "../domain/bsky.js";
import { StoreName } from "../domain/primitives.js";
import { storeOptions } from "./store.js";
import { withExamples } from "./help.js";
import { CliInputError } from "./errors.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";

const queryArg = Args.text({ name: "query" }).pipe(
  Args.withDescription("Search query string")
);

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of results"),
  Options.optional
);

const cursorOption = Options.text("cursor").pipe(
  Options.withDescription("Pagination cursor"),
  Options.optional
);

const typeaheadOption = Options.boolean("typeahead").pipe(
  Options.withDescription("Use prefix typeahead search (handles only)")
);

const searchFormatOption = Options.choice("format", ["json", "ndjson", "table"]).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to search")
);

const postCursorOption = Options.integer("cursor").pipe(
  Options.withDescription("Pagination offset for local search results"),
  Options.optional
);

const sortOption = Options.choice("sort", ["relevance", "newest", "oldest"]).pipe(
  Options.withDescription("Sort order for local search (default: relevance)"),
  Options.optional
);

const formatOption = Options.choice("format", ["json", "ndjson", "table"]).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const renderTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const widths = headers.map((header, i) => {
    const values = rows.map((row) => row[i] ?? "");
    return Math.max(header.length, ...values.map((value) => value.length));
  });
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ").trimEnd();
  return [line(headers), separator, ...rows.map(line)].join("\n");
};

const renderProfileTable = (
  actors: ReadonlyArray<ProfileView>,
  cursor: string | undefined
) => {
  const rows = actors.map((actor) => [
    actor.handle,
    actor.displayName ?? "",
    actor.did
  ]);
  const table = renderTable(["HANDLE", "DISPLAY NAME", "DID"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const renderFeedTable = (
  feeds: ReadonlyArray<FeedGeneratorView>,
  cursor: string | undefined
) => {
  const rows = feeds.map((feed) => [
    feed.displayName,
    feed.creator.handle,
    feed.uri,
    typeof feed.likeCount === "number" ? String(feed.likeCount) : ""
  ]);
  const table = renderTable(["NAME", "CREATOR", "URI", "LIKES"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const handlesCommand = Command.make(
  "handles",
  {
    query: queryArg,
    limit: limitOption,
    cursor: cursorOption,
    typeahead: typeaheadOption,
    format: searchFormatOption
  },
  ({ query, limit, cursor, typeahead, format }) =>
    Effect.gen(function* () {
      if (typeahead && Option.isSome(cursor)) {
        return yield* CliInputError.make({
          message: "--cursor is not supported with --typeahead.",
          cause: { cursor: cursor.value }
        });
      }
      const client = yield* BskyClient;
      const options = {
        ...(Option.isSome(limit) ? { limit: limit.value } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(typeahead ? { typeahead: true } : {})
      };
      const result = yield* client.searchActors(query, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.actors));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.actors, result.cursor));
        return;
      }
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Search for handles (profiles) on Bluesky", [
      "skygent search handles \"dan\" --limit 10",
      "skygent search handles \"alice\" --typeahead"
    ])
  )
);

const feedsCommand = Command.make(
  "feeds",
  { query: queryArg, limit: limitOption, cursor: cursorOption, format: searchFormatOption },
  ({ query, limit, cursor, format }) =>
    Effect.gen(function* () {
      const client = yield* BskyClient;
      const options = {
        ...(Option.isSome(limit) ? { limit: limit.value } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.searchFeedGenerators(query, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.feeds));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderFeedTable(result.feeds, result.cursor));
        return;
      }
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Search for feed generators on Bluesky", [
      "skygent search feeds \"news\" --limit 10"
    ])
  )
);

const postsCommand = Command.make(
  "posts",
  {
    query: queryArg,
    store: storeOption,
    limit: limitOption,
    cursor: postCursorOption,
    sort: sortOption,
    format: formatOption
  },
  ({ query, store, limit, cursor, sort, format }) =>
    Effect.gen(function* () {
      if (Option.isSome(limit) && limit.value <= 0) {
        return yield* CliInputError.make({
          message: "--limit must be a positive integer.",
          cause: { limit: limit.value }
        });
      }
      if (Option.isSome(cursor) && cursor.value < 0) {
        return yield* CliInputError.make({
          message: "--cursor must be a non-negative integer.",
          cause: { cursor: cursor.value }
        });
      }
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const index = yield* StoreIndex;
      const input = {
        query,
        ...(Option.isSome(limit) ? { limit: limit.value } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(sort) ? { sort: sort.value } : {})
      };
      const result = yield* index.searchPosts(storeRef, input);

      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        const stream = Stream.fromIterable(result.posts);
        yield* writeJsonStream(stream);
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderPostsTable(result.posts));
        return;
      }
      yield* writeJson({
        query,
        cursor: result.cursor,
        count: result.posts.length,
        posts: result.posts
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Search posts within a local store using FTS", [
      "skygent search posts \"deep learning\" --store my-store --limit 25",
      "skygent search posts \"bluesky\" --store my-store --format table",
      "skygent search posts \"effect\" --store my-store --sort newest"
    ])
  )
);

export const searchCommand = Command.make("search", {}).pipe(
  Command.withSubcommands([handlesCommand, feedsCommand, postsCommand]),
  Command.withDescription(
    withExamples("Search for handles, feeds, or posts", [
      "skygent search handles \"alice\"",
      "skygent search feeds \"news\"",
      "skygent search posts \"ai\" --store my-store"
    ])
  )
);

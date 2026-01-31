import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { renderTableLegacy } from "./doc/table.js";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsTable } from "../domain/format.js";
import { AppConfigService } from "../services/app-config.js";
import type { FeedGeneratorView, ProfileView } from "../domain/bsky.js";
import { StoreName } from "../domain/primitives.js";
import { storeOptions } from "./store.js";
import { withExamples } from "./help.js";
import { CliInputError } from "./errors.js";
import { decodeActor } from "./shared-options.js";
import { formatSchemaError } from "./shared.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";
import { parseLimit } from "./shared-options.js";

const queryArg = Args.text({ name: "query" }).pipe(
  Args.withDescription("Search query string")
);

const limitOption = baseLimitOption.pipe(
  Options.withDescription("Maximum number of results")
);

const cursorOption = baseCursorOption.pipe(
  Options.withDescription("Pagination cursor")
);

const typeaheadOption = Options.boolean("typeahead").pipe(
  Options.withDescription("Use prefix typeahead search (handles only)")
);

const formatOption = Options.choice("format", jsonNdjsonTableFormats).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to search")
);

const storeOptionOptional = storeOption.pipe(Options.optional);

const networkOption = Options.boolean("network").pipe(
  Options.withDescription("Search the Bluesky network instead of a local store")
);

const postCursorOption = baseCursorOption.pipe(
  Options.withDescription("Pagination cursor (network) or offset (local)")
);

const sortOption = Options.text("sort").pipe(
  Options.withDescription("Sort order (local: relevance|newest|oldest, network: top|latest)"),
  Options.optional
);

const sinceOption = Options.text("since").pipe(
  Options.withDescription("Filter network results after datetime (inclusive)"),
  Options.optional
);

const untilOption = Options.text("until").pipe(
  Options.withDescription("Filter network results before datetime (exclusive)"),
  Options.optional
);

const mentionsOption = Options.text("mentions").pipe(
  Options.withDescription("Filter network results by mention (handle or DID)"),
  Options.optional
);

const authorOption = Options.text("author").pipe(
  Options.withDescription("Filter network results by author (handle or DID)"),
  Options.optional
);

const langOption = Options.text("lang").pipe(
  Options.withDescription("Filter network results by language code"),
  Options.optional
);

const domainOption = Options.text("domain").pipe(
  Options.withDescription("Filter network results by link domain"),
  Options.optional
);

const urlOption = Options.text("url").pipe(
  Options.withDescription("Filter network results by URL"),
  Options.optional
);

const tagOption = Options.text("tag").pipe(
  Options.withDescription("Comma-separated tags for network search"),
  Options.optional
);

const requireNonEmptyQuery = (raw: string) =>
  Effect.gen(function* () {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return yield* CliInputError.make({
        message: "Search query must be non-empty.",
        cause: { query: raw }
      });
    }
    return trimmed;
  });


type LocalSort = "relevance" | "newest" | "oldest";

const renderProfileTable = (
  actors: ReadonlyArray<ProfileView>,
  cursor: string | undefined
) => {
  const rows = actors.map((actor) => [
    actor.handle,
    actor.displayName ?? "",
    actor.did
  ]);
  const table = renderTableLegacy(["HANDLE", "DISPLAY NAME", "DID"], rows);
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
  const table = renderTableLegacy(["NAME", "CREATOR", "URI", "LIKES"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const handlesCommand = Command.make(
  "handles",
  {
    query: queryArg,
    limit: limitOption,
    cursor: cursorOption,
    typeahead: typeaheadOption,
    format: formatOption
  },
  ({ query, limit, cursor, typeahead, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const queryValue = yield* requireNonEmptyQuery(query);
      if (typeahead && Option.isSome(cursor)) {
        return yield* CliInputError.make({
          message: "--cursor is not supported with --typeahead.",
          cause: { cursor: cursor.value }
        });
      }
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(typeahead ? { typeahead: true } : {})
      };
      const result = yield* client.searchActors(queryValue, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.actors)),
          table: writeText(renderProfileTable(result.actors, result.cursor))
        }
      );
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
  { query: queryArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ query, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const queryValue = yield* requireNonEmptyQuery(query);
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.searchFeedGenerators(queryValue, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.feeds)),
          table: writeText(renderFeedTable(result.feeds, result.cursor))
        }
      );
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
    store: storeOptionOptional,
    network: networkOption,
    limit: limitOption,
    cursor: postCursorOption,
    sort: sortOption,
    since: sinceOption,
    until: untilOption,
    mentions: mentionsOption,
    author: authorOption,
    lang: langOption,
    domain: domainOption,
    url: urlOption,
    tag: tagOption,
    format: formatOption
  },
  ({ query, store, network, limit, cursor, sort, since, until, mentions, author, lang, domain, url, tag, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const queryValue = yield* requireNonEmptyQuery(query);
      const parsedLimit = yield* parseLimit(limit);
      const limitValue = Option.getOrUndefined(parsedLimit);
      if (network && Option.isSome(store)) {
        return yield* CliInputError.make({
          message: "--store cannot be used with --network.",
          cause: { store: store.value }
        });
      }
      if (!network && Option.isNone(store)) {
        return yield* CliInputError.make({
          message: "Provide --store for local search or --network for Bluesky search.",
          cause: { store: null }
        });
      }
      const hasNetworkOnlyOption =
        Option.isSome(since) ||
        Option.isSome(until) ||
        Option.isSome(mentions) ||
        Option.isSome(author) ||
        Option.isSome(lang) ||
        Option.isSome(domain) ||
        Option.isSome(url) ||
        Option.isSome(tag);
      if (!network && hasNetworkOnlyOption) {
        return yield* CliInputError.make({
          message: "Network-only filters require --network.",
          cause: {
            since: Option.isSome(since),
            until: Option.isSome(until),
            mentions: Option.isSome(mentions),
            author: Option.isSome(author),
            lang: Option.isSome(lang),
            domain: Option.isSome(domain),
            url: Option.isSome(url),
            tag: Option.isSome(tag)
          }
        });
      }

      const storeValue = Option.getOrElse(store, () => undefined);

      if (network) {
        const client = yield* BskyClient;
        const parser = yield* PostParser;
        const sortRaw = Option.getOrElse(sort, () => undefined);
        const sortValue = Option.match(sort, {
          onNone: () => undefined,
          onSome: (value) =>
            value === "top" || value === "latest"
              ? value
              : undefined
        });
        if (sortRaw && !sortValue) {
          return yield* CliInputError.make({
            message: "--sort must be one of: top, latest (for --network).",
            cause: { sort: sortRaw }
          });
        }
        const cursorValue = Option.map(cursor, (value) => value);
        const tags = Option.match(tag, {
          onNone: () => [] as ReadonlyArray<string>,
          onSome: (value) =>
            value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
        });
        const authorValue = Option.match(author, {
          onNone: () => Effect.void.pipe(Effect.as(undefined)),
          onSome: (value) =>
            Effect.gen(function* () {
              const decoded = yield* decodeActor(value);
              return String(decoded);
            })
        });
        const mentionsValue = Option.match(mentions, {
          onNone: () => Effect.void.pipe(Effect.as(undefined)),
          onSome: (value) =>
            Effect.gen(function* () {
              const decoded = yield* decodeActor(value);
              return String(decoded);
            })
        });
      const parsedAuthor = yield* authorValue;
      const parsedMentions = yield* mentionsValue;
      const result = yield* client.searchPosts(queryValue, {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(Option.isSome(cursorValue) ? { cursor: cursorValue.value } : {}),
        ...(sortValue ? { sort: sortValue } : {}),
        ...(Option.isSome(since) ? { since: since.value } : {}),
          ...(Option.isSome(until) ? { until: until.value } : {}),
          ...(parsedMentions ? { mentions: parsedMentions } : {}),
          ...(parsedAuthor ? { author: parsedAuthor } : {}),
          ...(Option.isSome(lang) ? { lang: lang.value } : {}),
          ...(Option.isSome(domain) ? { domain: domain.value } : {}),
          ...(Option.isSome(url) ? { url: url.value } : {}),
          ...(tags.length > 0 ? { tags } : {})
        });
        const posts = yield* Effect.forEach(
          result.posts,
          (raw) =>
            parser.parsePost(raw).pipe(
              Effect.mapError((error) =>
                CliInputError.make({
                  message: `Failed to parse network post: ${formatSchemaError(error)}`,
                  cause: error
                })
              )
            ),
          { concurrency: "unbounded" }
        );
        yield* emitWithFormat(
          format,
          appConfig.outputFormat,
          jsonNdjsonTableFormats,
          "json",
          {
            json: writeJson({
              query: queryValue,
              cursor: result.cursor,
              hitsTotal: result.hitsTotal,
              count: posts.length,
              posts
            }),
            ndjson: writeJsonStream(Stream.fromIterable(posts)),
            table: writeText(renderPostsTable(posts))
          }
        );
        return;
      }

      if (!storeValue) {
        return yield* CliInputError.make({
          message: "Missing --store for local search.",
          cause: { store: null }
        });
      }
      const storeRef = yield* storeOptions.loadStoreRef(storeValue);
      const index = yield* StoreIndex;
      const parsedCursor = Option.match(cursor, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (value) => {
          const raw = value;
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 0) {
            return Effect.fail(
              CliInputError.make({
                message: "--cursor must be a non-negative integer for local search.",
                cause: { cursor: raw }
              })
            );
          }
          return Effect.succeed(Option.some(parsed));
        }
      });
      const cursorValue = yield* parsedCursor;
      const localSortRaw = Option.getOrElse(sort, () => undefined);
      const localSort = Option.match(sort, {
        onNone: () => "relevance" as const,
        onSome: (value) => {
          if (value === "relevance" || value === "newest" || value === "oldest") {
            return value;
          }
          return undefined;
        }
      }) as LocalSort | undefined;
      if (localSortRaw && !localSort) {
        return yield* CliInputError.make({
          message: "--sort must be one of: relevance, newest, oldest (for local search).",
          cause: { sort: localSortRaw }
        });
      }
      const input = {
        query: queryValue,
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(Option.isSome(cursorValue) ? { cursor: cursorValue.value } : {}),
        ...(localSort ? { sort: localSort } : {})
      };
      const result = yield* index.searchPosts(storeRef, input);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson({
            query: queryValue,
            cursor: result.cursor,
            count: result.posts.length,
            posts: result.posts
          }),
          ndjson: writeJsonStream(Stream.fromIterable(result.posts)),
          table: writeText(renderPostsTable(result.posts))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Search posts within a local store using FTS", [
      "skygent search posts \"deep learning\" --store my-store --limit 25",
      "skygent search posts \"bluesky\" --store my-store --format table",
      "skygent search posts \"effect\" --store my-store --sort newest",
      "skygent search posts \"ai\" --network --sort latest"
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

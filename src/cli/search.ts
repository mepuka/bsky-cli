import { Args, Command, Options } from "@effect/cli";
import { Clock, Effect, Option, Schema, Stream } from "effect";
import { renderFeedTable, renderProfileTable } from "./doc/table-renderers.js";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import { StoreIndex } from "../services/store-index.js";
import { renderPostsTable } from "../domain/format.js";
import { AppConfigService } from "../services/app-config.js";
import { ActorId, StoreName, Timestamp } from "../domain/primitives.js";
import { EventMeta, PostUpsert } from "../domain/events.js";
import { StoreCommitter } from "../services/store-commit.js";
import { storeOptions } from "./store.js";
import { withExamples } from "./help.js";
import { CliInputError } from "./errors.js";
import { formatSchemaError } from "./shared.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";
import { parseTimestampInput } from "./time.js";

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

const ingestOption = Options.text("ingest").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Ingest network search results into a store"),
  Options.optional
);

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
  Options.withDescription("Filter network results after datetime (inclusive); accepts YYYY-MM-DD"),
  Options.optional
);

const untilOption = Options.text("until").pipe(
  Options.withDescription("Filter network results before datetime (exclusive); accepts YYYY-MM-DD"),
  Options.optional
);

const mentionsOption = Options.text("mentions").pipe(
  Options.withSchema(ActorId),
  Options.withDescription("Filter network results by mention (handle or DID)"),
  Options.optional
);

const authorOption = Options.text("author").pipe(
  Options.withSchema(ActorId),
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

const formatArg = (value: string | number) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const buildNetworkSearchCommand = (input: {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: "top" | "latest";
  readonly since?: string;
  readonly until?: string;
  readonly mentions?: string;
  readonly author?: string;
  readonly lang?: string;
  readonly domain?: string;
  readonly url?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly ingest?: string;
}) => {
  const parts: Array<string> = ["search", "posts", formatArg(input.query), "--network"];
  if (input.limit !== undefined) {
    parts.push("--limit", String(input.limit));
  }
  if (input.cursor) {
    parts.push("--cursor", formatArg(input.cursor));
  }
  if (input.sort) {
    parts.push("--sort", input.sort);
  }
  if (input.since) {
    parts.push("--since", formatArg(input.since));
  }
  if (input.until) {
    parts.push("--until", formatArg(input.until));
  }
  if (input.mentions) {
    parts.push("--mentions", formatArg(input.mentions));
  }
  if (input.author) {
    parts.push("--author", formatArg(input.author));
  }
  if (input.lang) {
    parts.push("--lang", formatArg(input.lang));
  }
  if (input.domain) {
    parts.push("--domain", formatArg(input.domain));
  }
  if (input.url) {
    parts.push("--url", formatArg(input.url));
  }
  if (input.tags && input.tags.length > 0) {
    parts.push("--tag", formatArg(input.tags.join(",")));
  }
  if (input.ingest) {
    parts.push("--ingest", formatArg(input.ingest));
  }
  return parts.join(" ");
};

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
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
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
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
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
    ingest: ingestOption,
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
  ({ query, store, ingest, network, limit, cursor, sort, since, until, mentions, author, lang, domain, url, tag, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const queryValue = yield* requireNonEmptyQuery(query);
      const limitValue = Option.getOrUndefined(limit);
      if (network && Option.isSome(store)) {
        return yield* CliInputError.make({
          message: "--store cannot be used with --network.",
          cause: { store: store.value }
        });
      }
      if (Option.isSome(ingest) && !network) {
        return yield* CliInputError.make({
          message: "--ingest requires --network.",
          cause: { ingest: ingest.value }
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
        const parsedAuthor = Option.getOrUndefined(author);
        const parsedMentions = Option.getOrUndefined(mentions);
        const normalizedSince = yield* Option.match(since, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (value) =>
            parseTimestampInput(value, { label: "--since" }).pipe(
              Effect.map((date) => Option.some(date.toISOString()))
            )
        });
        const normalizedUntil = yield* Option.match(until, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (value) =>
            parseTimestampInput(value, { label: "--until" }).pipe(
              Effect.map((date) => Option.some(date.toISOString()))
            )
        });
        const result = yield* client.searchPosts(queryValue, {
          ...(limitValue !== undefined ? { limit: limitValue } : {}),
          ...(Option.isSome(cursorValue) ? { cursor: cursorValue.value } : {}),
          ...(sortValue ? { sort: sortValue } : {}),
          ...(Option.isSome(normalizedSince) ? { since: normalizedSince.value } : {}),
          ...(Option.isSome(normalizedUntil) ? { until: normalizedUntil.value } : {}),
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
        if (Option.isSome(ingest)) {
          const storeRef = yield* storeOptions.loadStoreRef(ingest.value);
          const committer = yield* StoreCommitter;
          const createdAt = yield* Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())
            )
          );
          const command = buildNetworkSearchCommand({
            query: queryValue,
            ...(limitValue !== undefined ? { limit: limitValue } : {}),
            ...(Option.isSome(cursorValue) ? { cursor: cursorValue.value } : {}),
            ...(sortValue ? { sort: sortValue } : {}),
            ...(Option.isSome(normalizedSince) ? { since: normalizedSince.value } : {}),
            ...(Option.isSome(normalizedUntil) ? { until: normalizedUntil.value } : {}),
            ...(parsedMentions ? { mentions: parsedMentions } : {}),
            ...(parsedAuthor ? { author: parsedAuthor } : {}),
            ...(Option.isSome(lang) ? { lang: lang.value } : {}),
            ...(Option.isSome(domain) ? { domain: domain.value } : {}),
            ...(Option.isSome(url) ? { url: url.value } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(Option.isSome(ingest) ? { ingest: ingest.value } : {})
          });
          const meta = EventMeta.make({
            source: "search",
            command,
            createdAt
          });
          const events = posts.map((post) => PostUpsert.make({ post, meta }));
          yield* committer.appendUpsertsIfMissing(storeRef, events);
        }
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
      "skygent search posts \"ai\" --network --sort latest",
      "skygent search posts \"Arsenal transfers\" --network --ingest my-store"
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

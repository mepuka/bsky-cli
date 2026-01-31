import { Command, Options } from "@effect/cli";
import { Context, Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import type { PostLike } from "../domain/bsky.js";
import type { RawPost } from "../domain/raw.js";
import { renderPostsTable } from "../domain/format.js";
import { AppConfigService } from "../services/app-config.js";
import { withExamples } from "./help.js";
import { postUriArg } from "./shared-options.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { renderTableLegacy } from "./doc/table.js";
import { renderProfileTable } from "./doc/table-renderers.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";
import { CliInputError } from "./errors.js";

const limitOption = baseLimitOption.pipe(
  Options.withDescription("Maximum number of results")
);

const cursorOption = baseCursorOption.pipe(
  Options.withDescription("Pagination cursor")
);

const formatOption = Options.choice("format", jsonNdjsonTableFormats).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const ensureSupportedFormat = (
  format: Option.Option<typeof jsonNdjsonTableFormats[number]>,
  configFormat: string
) =>
  Option.isNone(format) && configFormat === "markdown"
    ? CliInputError.make({
        message: 'Output format "markdown" is not supported for post commands. Use --format json|ndjson|table.',
        cause: { format: configFormat }
      })
    : Effect.void;

const cidOption = Options.text("cid").pipe(
  Options.withDescription("Filter engagement by specific record CID"),
  Options.optional
);


const renderLikesTable = (likes: ReadonlyArray<PostLike>, cursor: string | undefined) => {
  const rows = likes.map((like) => [
    like.actor.handle,
    like.actor.displayName ?? "",
    like.actor.did,
    like.createdAt.toISOString(),
    like.indexedAt.toISOString()
  ]);
  const table = renderTableLegacy(
    ["HANDLE", "DISPLAY NAME", "DID", "CREATED AT", "INDEXED AT"],
    rows
  );
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

type PostParserService = Context.Tag.Service<typeof PostParser>;

const parseRawPosts = (parser: PostParserService, posts: ReadonlyArray<RawPost>) =>
  Effect.forEach(posts, (raw) => parser.parsePost(raw), { concurrency: "unbounded" });

const likesCommand = Command.make(
  "likes",
  { uri: postUriArg, cid: cidOption, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ uri, cid, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const result = yield* client.getLikes(uri, {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.likes)),
          table: writeText(renderLikesTable(result.likes, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List accounts that liked a post", [
      "skygent post likes at://did:plc:example/app.bsky.feed.post/xyz",
      "skygent post likes at://did:plc:example/app.bsky.feed.post/xyz --limit 50"
    ])
  )
);

const repostedByCommand = Command.make(
  "reposted-by",
  { uri: postUriArg, cid: cidOption, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ uri, cid, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const result = yield* client.getRepostedBy(uri, {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.repostedBy)),
          table: writeText(renderProfileTable(result.repostedBy, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List accounts that reposted a post", [
      "skygent post reposted-by at://did:plc:example/app.bsky.feed.post/xyz"
    ])
  )
);

const quotesCommand = Command.make(
  "quotes",
  { uri: postUriArg, cid: cidOption, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ uri, cid, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      const parser = yield* PostParser;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const result = yield* client.getQuotes(uri, {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      const posts = yield* parseRawPosts(parser, result.posts);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson({
            ...result,
            posts
          }),
          ndjson: writeJsonStream(Stream.fromIterable(posts)),
          table: writeText(renderPostsTable(posts))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List quote-posts for a post", [
      "skygent post quotes at://did:plc:example/app.bsky.feed.post/xyz"
    ])
  )
);

export const postCommand = Command.make("post", {}).pipe(
  Command.withSubcommands([likesCommand, repostedByCommand, quotesCommand]),
  Command.withDescription(
    withExamples("Inspect post engagement", [
      "skygent post likes at://did:plc:example/app.bsky.feed.post/xyz",
      "skygent post quotes at://did:plc:example/app.bsky.feed.post/xyz"
    ])
  )
);

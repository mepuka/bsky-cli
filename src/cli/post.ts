import { Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { PostParser } from "../services/post-parser.js";
import type { PostLike, ProfileView } from "../domain/bsky.js";
import type { RawPost } from "../domain/raw.js";
import { renderPostsTable } from "../domain/format.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { postUriArg } from "./shared-options.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { Context } from "effect";
import { renderTableLegacy } from "./doc/table.js";

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of results"),
  Options.optional
);

const cursorOption = Options.text("cursor").pipe(
  Options.withDescription("Pagination cursor"),
  Options.optional
);

const formatOption = Options.choice("format", ["json", "ndjson", "table"]).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

const cidOption = Options.text("cid").pipe(
  Options.withDescription("Filter engagement by specific record CID"),
  Options.optional
);

const parseLimit = (limit: Option.Option<number>) =>
  Option.match(limit, {
    onNone: () => Effect.void.pipe(Effect.as(undefined)),
    onSome: (value) =>
      value <= 0
        ? Effect.fail(
            CliInputError.make({
              message: "--limit must be a positive integer.",
              cause: { limit: value }
            })
          )
        : Effect.succeed(value)
  });

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
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const result = yield* client.getLikes(uri, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.likes));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderLikesTable(result.likes, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const result = yield* client.getRepostedBy(uri, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.repostedBy));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.repostedBy, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const parser = yield* PostParser;
      const parsedLimit = yield* parseLimit(limit);
      const result = yield* client.getQuotes(uri, {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(cid) ? { cid: cid.value } : {})
      });
      const posts = yield* parseRawPosts(parser, result.posts);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(posts));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderPostsTable(posts));
        return;
      }
      yield* writeJson({
        ...result,
        posts
      });
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

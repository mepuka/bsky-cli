import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { renderTableLegacy } from "./doc/table.js";
import { BskyClient } from "../services/bsky-client.js";
import type { FeedGeneratorView } from "../domain/bsky.js";
import { AppConfigService } from "../services/app-config.js";
import { decodeActor, parseLimit } from "./shared-options.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { jsonNdjsonTableFormats, resolveOutputFormat } from "./output-format.js";

const feedUriArg = Args.text({ name: "uri" }).pipe(
  Args.withDescription("Bluesky feed URI (at://...)")
);

const feedUrisArg = Args.text({ name: "uri" }).pipe(
  Args.repeated,
  Args.withDescription("Feed URIs to fetch")
);

const actorArg = Args.text({ name: "actor" }).pipe(
  Args.withDescription("Bluesky handle or DID")
);

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of results"),
  Options.optional
);

const cursorOption = Options.text("cursor").pipe(
  Options.withDescription("Pagination cursor"),
  Options.optional
);

const formatOption = Options.choice("format", jsonNdjsonTableFormats).pipe(
  Options.withDescription("Output format (default: json)"),
  Options.optional
);

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

const renderFeedInfoTable = (
  view: FeedGeneratorView,
  isOnline: boolean,
  isValid: boolean
) =>
  renderTableLegacy(
    ["NAME", "CREATOR", "URI", "ONLINE", "VALID"],
    [[view.displayName, view.creator.handle, view.uri, String(isOnline), String(isValid)]]
  );

const showCommand = Command.make(
  "show",
  { uri: feedUriArg, format: formatOption },
  ({ uri, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const result = yield* client.getFeedGenerator(uri);
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json"
      );
      if (outputFormat === "table") {
        yield* writeText(renderFeedInfoTable(result.view, result.isOnline, result.isValid));
        return;
      }
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Show feed generator details", [
      "skygent feed show at://did:plc:example/app.bsky.feed.generator/xyz"
    ])
  )
);

const batchCommand = Command.make(
  "batch",
  { uris: feedUrisArg, format: formatOption },
  ({ uris, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      if (uris.length === 0) {
        return yield* CliInputError.make({
          message: "Provide at least one feed URI.",
          cause: { uris }
        });
      }
      const result = yield* client.getFeedGenerators(uris);
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json"
      );
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.feeds));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderFeedTable(result.feeds, undefined));
        return;
      }
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Fetch multiple feed generators", [
      "skygent feed batch at://did:plc:example/app.bsky.feed.generator/one at://did:plc:example/app.bsky.feed.generator/two"
    ])
  )
);

const byActorCommand = Command.make(
  "by",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ actor, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const resolvedActor = yield* decodeActor(actor);
      const result = yield* client.getActorFeeds(resolvedActor, {
        ...(Option.isSome(parsedLimit) ? { limit: parsedLimit.value } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      });
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json"
      );
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
    withExamples("List feeds created by an actor", [
      "skygent feed by alice.bsky.social",
      "skygent feed by did:plc:example --limit 25"
    ])
  )
);

export const feedCommand = Command.make("feed", {}).pipe(
  Command.withSubcommands([showCommand, batchCommand, byActorCommand]),
  Command.withDescription(
    withExamples("Discover feed generators", [
      "skygent feed show at://did:plc:example/app.bsky.feed.generator/xyz",
      "skygent feed by alice.bsky.social"
    ])
  )
);

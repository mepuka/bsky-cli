import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { renderTableLegacy } from "./doc/table.js";
import { renderFeedTable } from "./doc/table-renderers.js";
import { BskyClient } from "../services/bsky-client.js";
import { AppConfigService } from "../services/app-config.js";
import type { FeedGeneratorView } from "../domain/bsky.js";
import { AtUri } from "../domain/primitives.js";
import { decodeActor } from "./shared-options.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";

const feedUriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(AtUri),
  Args.withDescription("Bluesky feed URI (at://...)")
);

const feedUrisArg = Args.text({ name: "uri" }).pipe(
  Args.repeated,
  Args.withDescription("Feed URIs to fetch")
);

const actorArg = Args.text({ name: "actor" }).pipe(
  Args.withDescription("Bluesky handle or DID")
);

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
        message: 'Output format "markdown" is not supported for feed commands. Use --format json|ndjson|table.',
        cause: { format: configFormat }
      })
    : Effect.void;


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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      const result = yield* client.getFeedGenerator(uri);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJson(result),
          table: writeText(renderFeedInfoTable(result.view, result.isOnline, result.isValid))
        }
      );
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      if (uris.length === 0) {
        return yield* CliInputError.make({
          message: "Provide at least one feed URI.",
          cause: { uris }
        });
      }
      const result = yield* client.getFeedGenerators(uris);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.feeds)),
          table: writeText(renderFeedTable(result.feeds, undefined))
        }
      );
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const resolvedActor = yield* decodeActor(actor);
      const result = yield* client.getActorFeeds(resolvedActor, {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      });
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

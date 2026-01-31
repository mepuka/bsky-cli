import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { AppConfigService } from "../services/app-config.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { ProfileResolver } from "../services/profile-resolver.js";
import type { ListItemView, ListView } from "../domain/bsky.js";
import { decodeActor } from "./shared-options.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { renderTableLegacy } from "./doc/table.js";
import { renderProfileTable } from "./doc/table-renderers.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";
import {
  buildRelationshipGraph,
  relationshipEntries,
  type RelationshipEntry,
  type RelationshipNode
} from "../graph/relationships.js";

const actorArg = Args.text({ name: "actor" }).pipe(
  Args.withDescription("Bluesky handle or DID")
);

const listUriArg = Args.text({ name: "uri" }).pipe(
  Args.withDescription("Bluesky list URI (at://...)")
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

const purposeOption = Options.choice("purpose", ["modlist", "curatelist"]).pipe(
  Options.withDescription("List purpose filter"),
  Options.optional
);

const othersOption = Options.text("others").pipe(
  Options.withDescription("Comma-separated list of actors to compare" )
);
const rawOption = Options.boolean("raw").pipe(
  Options.withDescription("Output raw relationship data (no wrapper fields)")
);

const renderListTable = (
  lists: ReadonlyArray<ListView>,
  cursor: string | undefined
) => {
  const rows = lists.map((list) => [
    list.name,
    list.purpose,
    list.creator.handle,
    list.uri,
    typeof list.listItemCount === "number" ? String(list.listItemCount) : ""
  ]);
  const table = renderTableLegacy(["NAME", "PURPOSE", "CREATOR", "URI", "ITEMS"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const renderRelationshipsTable = (entries: ReadonlyArray<RelationshipEntry>) => {
  const rows = entries.map((entry) => {
    const otherInputs = entry.other.inputs.join(", ");
    const handle = entry.other.handle ?? "";
    const did = entry.other.did ?? (entry.other.notFound ? "not-found" : "");
    const rel = entry.relationship;
    return [
      otherInputs,
      handle,
      did,
      rel.following ? "yes" : "",
      rel.followedBy ? "yes" : "",
      rel.mutual ? "yes" : "",
      rel.blocking ? "yes" : "",
      rel.blockedBy ? "yes" : "",
      rel.blockingByList ? "yes" : "",
      rel.blockedByList ? "yes" : ""
    ];
  });
  return renderTableLegacy(
    [
      "INPUTS",
      "HANDLE",
      "DID",
      "FOLLOWING",
      "FOLLOWED BY",
      "MUTUAL",
      "BLOCKING",
      "BLOCKED BY",
      "BLOCK BY LIST",
      "BLOCKED BY LIST"
    ],
    rows
  );
};

const renderListItemsTable = (items: ReadonlyArray<ListItemView>, cursor: string | undefined) => {
  const rows = items.map((item) => [
    item.subject.handle,
    item.subject.displayName ?? "",
    item.subject.did
  ]);
  const table = renderTableLegacy(["HANDLE", "DISPLAY NAME", "DID"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const followersCommand = Command.make(
  "followers",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ actor, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getFollowers(resolvedActor, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.followers)),
          table: writeText(renderProfileTable(result.followers, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List followers for an actor", [
      "skygent graph followers alice.bsky.social",
      "skygent graph followers did:plc:example --limit 25"
    ])
  )
);

const followsCommand = Command.make(
  "follows",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ actor, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getFollows(resolvedActor, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.follows)),
          table: writeText(renderProfileTable(result.follows, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List accounts an actor follows", [
      "skygent graph follows alice.bsky.social",
      "skygent graph follows did:plc:example --limit 25"
    ])
  )
);

const knownFollowersCommand = Command.make(
  "known-followers",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ actor, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getKnownFollowers(resolvedActor, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.followers)),
          table: writeText(renderProfileTable(result.followers, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List mutual followers (viewer context)", [
      "skygent graph known-followers alice.bsky.social"
    ])
  )
);

const relationshipsCommand = Command.make(
  "relationships",
  { actor: actorArg, others: othersOption, format: formatOption, raw: rawOption },
  ({ actor, others, format, raw }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const identities = yield* IdentityResolver;
      const profiles = yield* ProfileResolver;
      const resolveDid = (value: string) =>
        Effect.gen(function* () {
          const decoded = yield* decodeActor(value);
          const actorValue = String(decoded);
          return actorValue.startsWith("did:")
            ? actorValue
            : yield* identities.resolveDid(actorValue);
        });
      const resolvedActor = yield* resolveDid(actor);
      const parsedOthers = others
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (parsedOthers.length === 0) {
        return yield* CliInputError.make({
          message: "--others must include at least one actor.",
          cause: { others }
        });
      }
      const uniqueOthers = Array.from(new Set(parsedOthers));
      if (uniqueOthers.length > 30) {
        return yield* CliInputError.make({
          message: "--others supports up to 30 actors per request.",
          cause: { count: uniqueOthers.length }
        });
      }
      const resolvedOthers = yield* Effect.forEach(
        uniqueOthers,
        (value) => resolveDid(value),
        { concurrency: "unbounded" }
      );
      const didToInputs = new Map<string, Array<string>>();
      resolvedOthers.forEach((did, index) => {
        const input = uniqueOthers[index];
        if (input) {
          const existing = didToInputs.get(did);
          if (existing) {
            existing.push(input);
          } else {
            didToInputs.set(did, [input]);
          }
        }
      });
      const result = yield* client.getRelationships(resolvedActor, resolvedOthers);
      const handleFromInputs = (inputs: ReadonlyArray<string>) =>
        inputs.find((input) => !input.startsWith("did:"));
      const inputsForActor = [actor];
      const didsNeedingHandle = [resolvedActor, ...resolvedOthers].filter((did) => {
        const inputs = did === resolvedActor ? inputsForActor : didToInputs.get(did) ?? [];
        return handleFromInputs(inputs) === undefined;
      });
      const handles = yield* Effect.forEach(
        didsNeedingHandle,
        (did) =>
          profiles.handleForDid(did).pipe(
            Effect.either,
            Effect.map((result) => [did, result] as const)
          ),
        { concurrency: "unbounded" }
      );
      const handleMap = new Map<string, string>();
      for (const [did, result] of handles) {
        if (result._tag === "Right") {
          handleMap.set(did, String(result.right));
        }
      }
      const buildNode = (
        did: string,
        inputs: ReadonlyArray<string>,
        handle?: string
      ): RelationshipNode => ({
        did,
        inputs,
        ...(handle ? { handle } : {})
      });
      const actorHandle = handleFromInputs(inputsForActor) ?? handleMap.get(resolvedActor);
      const nodesByKey = new Map<string, RelationshipNode>();
      nodesByKey.set(resolvedActor, buildNode(resolvedActor, inputsForActor, actorHandle));
      for (const [did, inputs] of didToInputs.entries()) {
        const handle = handleFromInputs(inputs) ?? handleMap.get(did);
        nodesByKey.set(did, buildNode(did, inputs, handle));
      }
      const graphResult = buildRelationshipGraph(
        resolvedActor,
        nodesByKey,
        result.relationships
      );
      const entries = relationshipEntries(graphResult.graph);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: raw
            ? writeJson(result)
            : writeJson({
                actor: nodesByKey.get(resolvedActor) ?? {
                  did: resolvedActor,
                  inputs: [actor]
                },
                relationships: entries
              }),
          ndjson: raw
            ? writeJsonStream(Stream.fromIterable(result.relationships))
            : writeJsonStream(Stream.fromIterable(entries)),
          table: writeText(renderRelationshipsTable(entries))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Inspect relationship status between actors", [
      "skygent graph relationships alice.bsky.social --others bob.bsky.social,charlie.bsky.social"
    ])
  )
);

const listsCommand = Command.make(
  "lists",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, purpose: purposeOption, format: formatOption },
  ({ actor, limit, cursor, purpose, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(Option.isSome(purpose) ? { purposes: [purpose.value] } : {})
      };
      const result = yield* client.getLists(resolvedActor, options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.lists)),
          table: writeText(renderListTable(result.lists, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List lists created by an actor", [
      "skygent graph lists alice.bsky.social",
      "skygent graph lists alice.bsky.social --purpose curatelist"
    ])
  )
);

const listCommand = Command.make(
  "list",
  { uri: listUriArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ uri, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getList(uri, options);
      const header = `${result.list.name} (${result.list.purpose}) by ${result.list.creator.handle}`;
      const body = renderListItemsTable(result.items, result.cursor);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson: writeJsonStream(Stream.fromIterable(result.items)),
          table: writeText(`${header}\n\n${body}`)
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("View a list and its members", [
      "skygent graph list at://did:plc:example/app.bsky.graph.list/xyz"
    ])
  )
);

const blocksCommand = Command.make(
  "blocks",
  { limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getBlocks(options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson:
            result.blocks.length === 0
              ? writeText("[]")
              : writeJsonStream(Stream.fromIterable(result.blocks)),
          table: writeText(renderProfileTable(result.blocks, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List accounts blocked by the authenticated user", [
      "skygent graph blocks --limit 25"
    ])
  )
);

const mutesCommand = Command.make(
  "mutes",
  { limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = yield* parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getMutes(options);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(result),
          ndjson:
            result.mutes.length === 0
              ? writeText("[]")
              : writeJsonStream(Stream.fromIterable(result.mutes)),
          table: writeText(renderProfileTable(result.mutes, result.cursor))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("List accounts muted by the authenticated user", [
      "skygent graph mutes --limit 25"
    ])
  )
);

export const graphCommand = Command.make("graph", {}).pipe(
  Command.withSubcommands([
    followersCommand,
    followsCommand,
    knownFollowersCommand,
    relationshipsCommand,
    listsCommand,
    listCommand,
    blocksCommand,
    mutesCommand
  ]),
  Command.withDescription(
    withExamples("Inspect Bluesky social graph data", [
      "skygent graph followers alice.bsky.social",
      "skygent graph list at://did:plc:example/app.bsky.graph.list/xyz"
    ])
  )
);

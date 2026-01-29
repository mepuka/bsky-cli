import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import type { ListItemView, ListView, ProfileView, RelationshipView } from "../domain/bsky.js";
import { decodeActor } from "./shared-options.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";

const actorArg = Args.text({ name: "actor" }).pipe(
  Args.withDescription("Bluesky handle or DID")
);

const listUriArg = Args.text({ name: "uri" }).pipe(
  Args.withDescription("Bluesky list URI (at://...)")
);

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

const purposeOption = Options.choice("purpose", ["modlist", "curatelist"]).pipe(
  Options.withDescription("List purpose filter"),
  Options.optional
);

const othersOption = Options.text("others").pipe(
  Options.withDescription("Comma-separated list of actors to compare" )
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
  const table = renderTable(["NAME", "PURPOSE", "CREATOR", "URI", "ITEMS"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const renderRelationshipsTable = (relationships: ReadonlyArray<RelationshipView>) => {
  const rows = relationships.map((rel) => {
    if ("notFound" in rel && rel.notFound) {
      return [String(rel.actor), "not-found", "", "", "", "", ""];
    }
    const relationship = rel as RelationshipView & {
      did: string;
      following?: string;
      followedBy?: string;
      blocking?: string;
      blockedBy?: string;
      blockingByList?: string;
      blockedByList?: string;
    };
    return [
      relationship.did,
      relationship.following ? "yes" : "",
      relationship.followedBy ? "yes" : "",
      relationship.blocking ? "yes" : "",
      relationship.blockedBy ? "yes" : "",
      relationship.blockingByList ? "yes" : "",
      relationship.blockedByList ? "yes" : ""
    ];
  });
  return renderTable(
    [
      "DID",
      "FOLLOWING",
      "FOLLOWED BY",
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
  const table = renderTable(["HANDLE", "DISPLAY NAME", "DID"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

const followersCommand = Command.make(
  "followers",
  { actor: actorArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ actor, limit, cursor, format }) =>
    Effect.gen(function* () {
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getFollowers(resolvedActor, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.followers));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.followers, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getFollows(resolvedActor, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.follows));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.follows, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getKnownFollowers(resolvedActor, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.followers));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.followers, result.cursor));
        return;
      }
      yield* writeJson(result);
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
  { actor: actorArg, others: othersOption, format: formatOption },
  ({ actor, others, format }) =>
    Effect.gen(function* () {
      const client = yield* BskyClient;
      const resolveDid = (value: string) =>
        Effect.gen(function* () {
          const decoded = yield* decodeActor(value);
          const actorValue = String(decoded);
          return actorValue.startsWith("did:")
            ? actorValue
            : yield* client.resolveHandle(actorValue);
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
      const result = yield* client.getRelationships(resolvedActor, resolvedOthers);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.relationships));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderRelationshipsTable(result.relationships));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const resolvedActor = yield* decodeActor(actor);
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        ...(Option.isSome(purpose) ? { purposes: [purpose.value] } : {})
      };
      const result = yield* client.getLists(resolvedActor, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.lists));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderListTable(result.lists, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getList(uri, options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.items));
        return;
      }
      if (outputFormat === "table") {
        const header = `${result.list.name} (${result.list.purpose}) by ${result.list.creator.handle}`;
        const body = renderListItemsTable(result.items, result.cursor);
        yield* writeText(`${header}\n\n${body}`);
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getBlocks(options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.blocks));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.blocks, result.cursor));
        return;
      }
      yield* writeJson(result);
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
      const client = yield* BskyClient;
      const parsedLimit = yield* parseLimit(limit);
      const options = {
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {})
      };
      const result = yield* client.getMutes(options);
      const outputFormat = Option.getOrElse(format, () => "json" as const);
      if (outputFormat === "ndjson") {
        yield* writeJsonStream(Stream.fromIterable(result.mutes));
        return;
      }
      if (outputFormat === "table") {
        yield* writeText(renderProfileTable(result.mutes, result.cursor));
        return;
      }
      yield* writeJson(result);
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

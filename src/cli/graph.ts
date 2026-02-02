import { Args, Command, Options } from "@effect/cli";
import { Either, Effect, Option, Stream } from "effect";
import { BskyClient } from "../services/bsky-client.js";
import { AppConfigService } from "../services/app-config.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { ProfileResolver } from "../services/profile-resolver.js";
import { GraphBuilder } from "../services/graph-builder.js";
import { StoreTopology } from "../services/store-topology.js";
import type { ListItemView, ListView } from "../domain/bsky.js";
import { AtUri, StoreName } from "../domain/primitives.js";
import type { GraphSnapshot } from "../domain/graph.js";
import { actorArg, decodeActor } from "./shared-options.js";
import { CliInputError } from "./errors.js";
import { withExamples } from "./help.js";
import { writeJson, writeJsonStream, writeText } from "./output.js";
import { renderTableLegacy } from "./doc/table.js";
import { renderProfileTable } from "./doc/table-renderers.js";
import { jsonNdjsonTableFormats } from "./output-format.js";
import { emitWithFormat } from "./output-render.js";
import { cursorOption as baseCursorOption, limitOption as baseLimitOption, parsePagination } from "./pagination.js";
import { CliPreferences } from "./preferences.js";
import { compactListItemView, compactListView, compactProfileView } from "./compact-output.js";
import {
  buildRelationshipGraph,
  relationshipEntries,
  type RelationshipEntry,
  type RelationshipNode
} from "../graph/relationships.js";
import { parseRangeOptions } from "./range-options.js";
import { parseOptionalFilterExpr } from "./filter-input.js";
import { filterOption, filterJsonOption } from "./shared-options.js";
import { storeOptions } from "./store.js";
import { StoreQuery } from "../domain/events.js";
import { PositiveInt, boundedInt } from "./option-schemas.js";
import { degreeCentrality, graphFromSnapshot, pageRankCentrality } from "../graph/centrality.js";
import { communitiesFromSnapshot } from "../graph/communities.js";
import { formatFilterExpr } from "../domain/filter-describe.js";

const listUriArg = Args.text({ name: "uri" }).pipe(
  Args.withSchema(AtUri),
  Args.withDescription("Bluesky list URI (at://...)")
);

const limitOption = baseLimitOption.pipe(
  Options.withDescription("Maximum number of results")
);

const storeLimitOption = baseLimitOption.pipe(
  Options.withDescription("Maximum posts to include when building store graphs")
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
        message: 'Output format "markdown" is not supported for graph commands. Use --format json|ndjson|table.',
        cause: { format: configFormat }
      })
    : Effect.void;

const snapshotMeta = (snapshot: GraphSnapshot, extra: Record<string, unknown> = {}) => ({
  kind: "meta" as const,
  directed: snapshot.directed,
  builtAt: snapshot.builtAt,
  sources: snapshot.sources,
  window: snapshot.window,
  filters: snapshot.filters,
  nodeCount: snapshot.nodes.length,
  edgeCount: snapshot.edges.length,
  ...extra
});

const purposeOption = Options.choice("purpose", ["modlist", "curatelist"]).pipe(
  Options.withDescription("List purpose filter"),
  Options.optional
);

const storeOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to build the interaction graph from")
);

const rangeOption = Options.text("range").pipe(
  Options.withDescription("ISO range as <start>..<end>"),
  Options.optional
);
const sinceOption = Options.text("since").pipe(
  Options.withDescription(
    "Start time (ISO timestamp, date, relative duration like 24h, or now/today/yesterday)"
  ),
  Options.optional
);
const untilOption = Options.text("until").pipe(
  Options.withDescription(
    "End time (ISO timestamp, date, relative duration like 24h, or now/today/yesterday)"
  ),
  Options.optional
);
const scanLimitOption = Options.integer("scan-limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum rows to scan before filtering (advanced)"),
  Options.optional
);

const metricOption = Options.choice("metric", ["degree", "pagerank"]).pipe(
  Options.withDescription("Centrality metric (default: degree)"),
  Options.optional
);

const directionOption = Options.choice("direction", ["in", "out", "both"]).pipe(
  Options.withDescription("Degree direction (default: both)"),
  Options.optional
);

const weightedOption = Options.boolean("weighted").pipe(
  Options.withDescription("Use edge weights in centrality computation")
);

const iterationsOption = Options.integer("iterations").pipe(
  Options.withSchema(boundedInt(1, 500)),
  Options.withDescription("Pagerank iterations (default: 20)"),
  Options.optional
);

const communityIterationsOption = Options.integer("iterations").pipe(
  Options.withSchema(boundedInt(1, 200)),
  Options.withDescription("Community detection iterations (default: 10)"),
  Options.optional
);

const topOption = Options.integer("top").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Limit number of ranked nodes in output"),
  Options.optional
);

const minSizeOption = Options.integer("min-size").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Minimum community size to include"),
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

const renderInteractionTable = (snapshot: GraphSnapshot) => {
  const labels = new Map(snapshot.nodes.map((node) => [String(node.id), node.label ?? ""]));
  const rows = snapshot.edges.map((edge) => [
    String(edge.from),
    labels.get(String(edge.from)) ?? "",
    String(edge.to),
    labels.get(String(edge.to)) ?? "",
    edge.type,
    String(edge.weight ?? 1)
  ]);
  return renderTableLegacy(
    ["FROM", "FROM_HANDLE", "TO", "TO_HANDLE", "TYPE", "WEIGHT"],
    rows
  );
};

const renderCentralityTable = (entries: ReadonlyArray<{
  readonly rank: number;
  readonly did: string;
  readonly handle?: string;
  readonly score: number;
}>) => {
  const rows = entries.map((entry) => [
    String(entry.rank),
    entry.did,
    entry.handle ?? "",
    entry.score.toString()
  ]);
  return renderTableLegacy(["RANK", "DID", "HANDLE", "SCORE"], rows);
};

const renderCommunitiesTable = (entries: ReadonlyArray<{
  readonly community: string;
  readonly size: number;
  readonly members: string;
}>) => {
  const rows = entries.map((entry) => [
    String(entry.community),
    String(entry.size),
    entry.members
  ]);
  return renderTableLegacy(["COMMUNITY", "SIZE", "MEMBERS"], rows);
};

const renderStoreTopologyTable = (
  nodes: ReadonlyArray<{ readonly name: string; readonly derived: boolean; readonly posts: number; readonly sources: number; readonly root: boolean }>,
  edges: ReadonlyArray<{ readonly source: string; readonly target: string; readonly filter: string; readonly mode: string; readonly derivedAt?: string }>
) => {
  const storeRows = nodes.map((node) => [
    node.name,
    node.derived ? "derived" : "source",
    node.root ? "yes" : "no",
    String(node.posts),
    String(node.sources)
  ]);
  const edgeRows = edges.map((edge) => [
    edge.source,
    edge.target,
    edge.filter,
    edge.mode,
    edge.derivedAt ?? "-"
  ]);
  const sections = [
    `Stores\n${renderTableLegacy(["STORE", "KIND", "ROOT", "POSTS", "SOURCES"], storeRows)}`,
    `Derivations\n${renderTableLegacy(["SOURCE", "TARGET", "FILTER", "MODE", "DERIVED AT"], edgeRows)}`
  ];
  return sections.join("\n\n");
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getFollowers(actor, options);
      const subject = preferences.compact
        ? compactProfileView(result.subject)
        : result.subject;
      const followers = preferences.compact
        ? result.followers.map(compactProfileView)
        : result.followers;
      const payload = result.cursor
        ? { subject, followers, cursor: result.cursor }
        : { subject, followers };
      const followersStream = Stream.fromIterable(
        followers as ReadonlyArray<unknown>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(followersStream),
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getFollows(actor, options);
      const subject = preferences.compact
        ? compactProfileView(result.subject)
        : result.subject;
      const follows = preferences.compact
        ? result.follows.map(compactProfileView)
        : result.follows;
      const payload = result.cursor
        ? { subject, follows, cursor: result.cursor }
        : { subject, follows };
      const followsStream = Stream.fromIterable(
        follows as ReadonlyArray<unknown>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(followsStream),
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getKnownFollowers(actor, options);
      const subject = preferences.compact
        ? compactProfileView(result.subject)
        : result.subject;
      const followers = preferences.compact
        ? result.followers.map(compactProfileView)
        : result.followers;
      const payload = result.cursor
        ? { subject, followers, cursor: result.cursor }
        : { subject, followers };
      const followersStream = Stream.fromIterable(
        followers as ReadonlyArray<unknown>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(followersStream),
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
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
      const resolvedActor = actor.startsWith("did:")
        ? actor
        : yield* identities.resolveDid(actor);
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
        if (Either.isRight(result)) {
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
        ...(Option.isSome(purpose) ? { purposes: [purpose.value] } : {})
      };
      const result = yield* client.getLists(actor, options);
      const lists = preferences.compact
        ? result.lists.map(compactListView)
        : result.lists;
      const payload = result.cursor ? { lists, cursor: result.cursor } : { lists };
      const listsStream = Stream.fromIterable(
        lists as ReadonlyArray<ListView | ReturnType<typeof compactListView>>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(listsStream),
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

const interactionsCommand = Command.make(
  "interactions",
  {
    store: storeOption,
    range: rangeOption,
    since: sinceOption,
    until: untilOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    limit: storeLimitOption,
    scanLimit: scanLimitOption,
    format: formatOption
  },
  ({ store, range, since, until, filter, filterJson, limit, scanLimit, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const builder = yield* GraphBuilder;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOptions(range, since, until);
      const parsedFilter = yield* parseOptionalFilterExpr(filter, filterJson);
      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        scanLimit: Option.getOrUndefined(scanLimit)
      });
      const limitValue = Option.getOrUndefined(limit);
      const snapshot = yield* builder.buildInteractionNetwork(
        storeRef,
        limitValue === undefined ? { query } : { query, limit: limitValue }
      );
      const ndjsonItems = [
        snapshotMeta(snapshot, { store: storeRef.name }),
        ...snapshot.nodes.map((node) => ({ kind: "node", ...node })),
        ...snapshot.edges.map((edge) => ({ kind: "edge", ...edge }))
      ];
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(snapshot),
          ndjson: writeJsonStream(Stream.fromIterable(ndjsonItems)),
          table: writeText(renderInteractionTable(snapshot))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Build an interaction network from store posts", [
      "skygent graph interactions --store my-store --range 2026-01-01..2026-01-31",
      "skygent graph interactions --store my-store --filter 'hashtag:#ai' --format table",
      "skygent graph interactions --store my-store --limit 500 --format ndjson"
    ])
  )
);

const centralityCommand = Command.make(
  "centrality",
  {
    store: storeOption,
    range: rangeOption,
    since: sinceOption,
    until: untilOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    limit: storeLimitOption,
    scanLimit: scanLimitOption,
    metric: metricOption,
    direction: directionOption,
    weighted: weightedOption,
    iterations: iterationsOption,
    top: topOption,
    format: formatOption
  },
  ({ store, range, since, until, filter, filterJson, limit, scanLimit, metric, direction, weighted, iterations, top, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const builder = yield* GraphBuilder;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOptions(range, since, until);
      const parsedFilter = yield* parseOptionalFilterExpr(filter, filterJson);
      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        scanLimit: Option.getOrUndefined(scanLimit)
      });
      const limitValue = Option.getOrUndefined(limit);
      const snapshot = yield* builder.buildInteractionNetwork(
        storeRef,
        limitValue === undefined ? { query } : { query, limit: limitValue }
      );
      const { graph } = graphFromSnapshot(snapshot);

      const metricValue = Option.getOrElse(metric, () => "degree" as const);
      const directionValue = Option.getOrElse(direction, () => "both" as const);
      const iterationsValue = Option.getOrElse(iterations, () => 20);
      if (metricValue === "pagerank" && Option.isSome(direction)) {
        return yield* CliInputError.make({
          message: "--direction is only supported for degree centrality.",
          cause: { metric: metricValue, direction: directionValue }
        });
      }
      const scores = metricValue === "pagerank"
        ? pageRankCentrality(graph, { iterations: iterationsValue, weighted })
        : degreeCentrality(graph, { direction: directionValue, weighted });

      const topValue = Option.getOrUndefined(top);
      const trimmed = topValue ? scores.slice(0, topValue) : scores;
      const entries = trimmed.map((entry, index) => {
        const base = {
          rank: index + 1,
          did: String(entry.node.id),
          score: entry.score
        };
        return entry.node.label
          ? { ...base, handle: entry.node.label }
          : base;
      });
      const ndjsonItems = [
        snapshotMeta(snapshot, {
          store: storeRef.name,
          metric: metricValue,
          ...(metricValue === "degree" ? { direction: directionValue } : {}),
          ...(metricValue === "pagerank" ? { iterations: iterationsValue } : {}),
          weighted
        }),
        ...entries.map((entry) => ({ kind: "node", ...entry }))
      ];

      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson({
            metric: metricValue,
            nodes: entries
          }),
          ndjson: writeJsonStream(Stream.fromIterable(ndjsonItems)),
          table: writeText(renderCentralityTable(entries))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Rank actors by interaction centrality", [
      "skygent graph centrality --store my-store --metric degree --top 50",
      "skygent graph centrality --store my-store --metric degree --direction in --weighted",
      "skygent graph centrality --store my-store --metric pagerank --iterations 50 --top 25"
    ])
  )
);

const communitiesCommand = Command.make(
  "communities",
  {
    store: storeOption,
    range: rangeOption,
    since: sinceOption,
    until: untilOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    limit: storeLimitOption,
    scanLimit: scanLimitOption,
    iterations: communityIterationsOption,
    weighted: weightedOption,
    minSize: minSizeOption,
    top: topOption,
    format: formatOption
  },
  ({ store, range, since, until, filter, filterJson, limit, scanLimit, iterations, weighted, minSize, top, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const builder = yield* GraphBuilder;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const parsedRange = yield* parseRangeOptions(range, since, until);
      const parsedFilter = yield* parseOptionalFilterExpr(filter, filterJson);
      const query = StoreQuery.make({
        range: Option.getOrUndefined(parsedRange),
        filter: Option.getOrUndefined(parsedFilter),
        scanLimit: Option.getOrUndefined(scanLimit)
      });
      const limitValue = Option.getOrUndefined(limit);
      const snapshot = yield* builder.buildInteractionNetwork(
        storeRef,
        limitValue === undefined ? { query } : { query, limit: limitValue }
      );
      const communityIterations = Option.getOrElse(iterations, () => 10);
      const minSizeValue = Option.getOrElse(minSize, () => 1);
      const communities = communitiesFromSnapshot(snapshot, {
        iterations: communityIterations,
        weighted,
        minSize: minSizeValue
      });
      const topValue = Option.getOrUndefined(top);
      const trimmed = topValue ? communities.slice(0, topValue) : communities;
      const payload = trimmed.map((community) => ({
        id: community.id,
        size: community.members.length,
        members: community.members.map((member) => ({
          did: String(member.id),
          ...(member.label ? { handle: member.label } : {})
        }))
      }));
      const tableRows = trimmed.map((community) => {
        const handles = community.members
          .slice(0, 5)
          .map((member) => member.label ?? String(member.id));
        return {
          community: community.id,
          size: community.members.length,
          members: handles.join(", ")
        };
      });
      const ndjsonItems = [
        snapshotMeta(snapshot, {
          store: storeRef.name,
          iterations: communityIterations,
          weighted,
          minSize: minSizeValue,
          totalCommunities: communities.length
        }),
        ...payload.map((community) => ({ kind: "community", ...community }))
      ];

      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson({ communities: payload }),
          ndjson: writeJsonStream(Stream.fromIterable(ndjsonItems)),
          table: writeText(renderCommunitiesTable(tableRows))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Detect interaction communities in a store", [
      "skygent graph communities --store my-store --min-size 3",
      "skygent graph communities --store my-store --iterations 25 --weighted --format table"
    ])
  )
);

const storesCommand = Command.make(
  "stores",
  { format: formatOption },
  ({ format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const topology = yield* StoreTopology;
      const data = yield* topology.build();
      const roots = new Set(data.roots);
      const nodes = data.nodes.map((node) => ({
        name: node.name,
        derived: node.derived,
        posts: node.posts,
        sources: node.sources,
        root: roots.has(node.name)
      }));
      const edges = data.edges.map((edge) => {
        const base = {
          source: edge.source,
          target: edge.target,
          filter: formatFilterExpr(edge.filter),
          mode: edge.mode
        };
        return edge.derivedAt ? { ...base, derivedAt: edge.derivedAt } : base;
      });
      const payload = { roots: data.roots, nodes, edges };
      const ndjsonItems = [
        {
          kind: "meta" as const,
          roots: data.roots,
          nodeCount: nodes.length,
          edgeCount: edges.length
        },
        ...nodes.map((node) => ({ kind: "node", ...node })),
        ...edges.map((edge) => ({ kind: "edge", ...edge }))
      ];

      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(Stream.fromIterable(ndjsonItems)),
          table: writeText(renderStoreTopologyTable(nodes, edges))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples("Show cross-store topology from lineage data", [
      "skygent graph stores --format table",
      "skygent graph stores --format ndjson"
    ])
  )
);

const listCommand = Command.make(
  "list",
  { uri: listUriArg, limit: limitOption, cursor: cursorOption, format: formatOption },
  ({ uri, limit, cursor, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getList(uri, options);
      const list = preferences.compact ? compactListView(result.list) : result.list;
      const items = preferences.compact
        ? result.items.map(compactListItemView)
        : result.items;
      const payload = result.cursor
        ? { list, items, cursor: result.cursor }
        : { list, items };
      const itemsStream = Stream.fromIterable(
        items as ReadonlyArray<ListItemView | ReturnType<typeof compactListItemView>>
      );
      const header = `${result.list.name} (${result.list.purpose}) by ${result.list.creator.handle}`;
      const body = renderListItemsTable(result.items, result.cursor);
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(itemsStream),
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getBlocks(options);
      const blocks = preferences.compact
        ? result.blocks.map(compactProfileView)
        : result.blocks;
      const payload = result.cursor ? { blocks, cursor: result.cursor } : { blocks };
      const blocksStream = Stream.fromIterable(
        blocks as ReadonlyArray<unknown>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(blocksStream),
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
      yield* ensureSupportedFormat(format, appConfig.outputFormat);
      const preferences = yield* CliPreferences;
      const client = yield* BskyClient;
      const { limit: limitValue, cursor: cursorValue } = parsePagination(limit, cursor);
      const options = {
        ...(limitValue !== undefined ? { limit: limitValue } : {}),
        ...(cursorValue !== undefined ? { cursor: cursorValue } : {})
      };
      const result = yield* client.getMutes(options);
      const mutes = preferences.compact
        ? result.mutes.map(compactProfileView)
        : result.mutes;
      const payload = result.cursor ? { mutes, cursor: result.cursor } : { mutes };
      const mutesStream = Stream.fromIterable(
        mutes as ReadonlyArray<unknown>
      );
      yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        jsonNdjsonTableFormats,
        "json",
        {
          json: writeJson(payload),
          ndjson: writeJsonStream(mutesStream),
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
    interactionsCommand,
    centralityCommand,
    communitiesCommand,
    storesCommand,
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

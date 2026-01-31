import { Command, Options } from "@effect/cli";
import { Effect, Layer, Option } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { DataSource, SyncResult } from "../domain/sync.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { OutputManager } from "../services/output-manager.js";
import { StoreIndex } from "../services/store-index.js";
import { CliOutput, writeJson } from "./output.js";
import { parseFilterExpr } from "./filter-input.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";
import { makeSyncCommandBody } from "./sync-factory.js";
import {
  feedUriArg,
  listUriArg,
  postUriArg,
  actorArg,
  storeNameOption,
  filterOption,
  filterJsonOption,
  postFilterOption,
  postFilterJsonOption,
  authorFilterOption,
  includePinsOption,
  quietOption,
  refreshOption,
  strictOption,
  maxErrorsOption
} from "./shared-options.js";
import {
  depthOption as threadDepthOption,
  parentHeightOption as threadParentHeightOption,
  parseThreadDepth
} from "./thread-options.js";
import { DurationInput, PositiveInt } from "./option-schemas.js";

const syncLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of posts to sync"),
  Options.optional
);
const jetstreamLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of Jetstream events to process"),
  Options.optional
);
const durationOption = Options.text("duration").pipe(
  Options.withSchema(DurationInput),
  Options.withDescription("Stop after a duration (e.g. \"2 minutes\")"),
  Options.optional
);
const depthOption = threadDepthOption(
  "Thread reply depth to include (0-1000, default 6)"
);
const parentHeightOption = threadParentHeightOption(
  "Thread parent height to include (0-1000, default 80)"
);


const timelineCommand = Command.make(
  "timeline",
  { store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption, refresh: refreshOption, limit: syncLimitOption },
  makeSyncCommandBody("timeline", () => DataSource.timeline())
).pipe(
  Command.withDescription(
    withExamples(
      "Sync the authenticated timeline into a store",
      [
        "skygent sync timeline --store my-store",
        "skygent sync timeline --store my-store --filter 'hashtag:#ai' --quiet"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const feedCommand = Command.make(
  "feed",
  { uri: feedUriArg, store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption, refresh: refreshOption, limit: syncLimitOption },
  ({ uri, ...rest }) => makeSyncCommandBody("feed", () => DataSource.feed(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a feed URI into a store",
      [
        "skygent sync feed at://did:plc:example/app.bsky.feed.generator/xyz --store my-store"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const listCommand = Command.make(
  "list",
  { uri: listUriArg, store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption, refresh: refreshOption, limit: syncLimitOption },
  ({ uri, ...rest }) => makeSyncCommandBody("list", () => DataSource.list(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a list feed URI into a store",
      [
        "skygent sync list at://did:plc:example/app.bsky.graph.list/xyz --store my-store"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const notificationsCommand = Command.make(
  "notifications",
  { store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption, refresh: refreshOption, limit: syncLimitOption },
  makeSyncCommandBody("notifications", () => DataSource.notifications())
).pipe(
  Command.withDescription(
    withExamples(
      "Sync notifications into a store",
      ["skygent sync notifications --store my-store --quiet"],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const authorCommand = Command.make(
  "author",
  {
    actor: actorArg,
    store: storeNameOption,
    filter: authorFilterOption,
    includePins: includePinsOption,
    postFilter: postFilterOption,
    postFilterJson: postFilterJsonOption,
    quiet: quietOption,
    refresh: refreshOption,
    limit: syncLimitOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, store, quiet, refresh, limit }) =>
    Effect.gen(function* () {
      const apiFilter = Option.getOrUndefined(filter);
      const source = DataSource.author(actor, {
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      const run = makeSyncCommandBody("author", () => source, {
        actor,
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      return yield* run({
        store,
        filter: postFilter,
        filterJson: postFilterJson,
        quiet,
        refresh,
        limit
      });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync posts from a specific author",
      [
        "skygent sync author alice.bsky.social --store my-store",
        "skygent sync author did:plc:example --store my-store --filter posts_no_replies --include-pins"
      ],
      ["Tip: use --post-filter to apply the DSL filter to synced posts."]
    )
  )
);

const threadCommand = Command.make(
  "thread",
  {
    uri: postUriArg,
    store: storeNameOption,
    depth: depthOption,
    parentHeight: parentHeightOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    refresh: refreshOption,
    limit: syncLimitOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, store, quiet, refresh, limit }) =>
    Effect.gen(function* () {
      const { depth: depthValue, parentHeight: parentHeightValue } =
        parseThreadDepth(depth, parentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeSyncCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({ store, filter, filterJson, quiet, refresh, limit });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a post thread (parents + replies) into a store",
      [
        "skygent sync thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store",
        "skygent sync thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store --depth 10 --parent-height 5"
      ],
      ["Tip: use --filter to apply the DSL filter to thread posts."]
    )
  )
);

const jetstreamCommand = Command.make(
  "jetstream",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    endpoint: jetstreamOptions.endpoint,
    collections: jetstreamOptions.collections,
    dids: jetstreamOptions.dids,
    cursor: jetstreamOptions.cursor,
    compress: jetstreamOptions.compress,
    maxMessageSize: jetstreamOptions.maxMessageSize,
    limit: jetstreamLimitOption,
    duration: durationOption,
    strict: strictOption,
    maxErrors: maxErrorsOption
  },
  ({
    store,
    filter,
    filterJson,
    quiet,
    endpoint,
    collections,
    dids,
    cursor,
    compress,
    maxMessageSize,
    limit,
    duration,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const index = yield* StoreIndex;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const filterHash = filterExprSignature(expr);
      const selection = yield* buildJetstreamSelection(
        {
          endpoint,
          collections,
          dids,
          cursor,
          compress,
          maxMessageSize
        },
        storeRef,
        filterHash
      );
      const parsedDuration = duration;
      if (Option.isNone(limit) && Option.isNone(parsedDuration)) {
        return yield* CliInputError.make({
          message:
            "Jetstream sync requires --limit or --duration. Use watch jetstream for continuous streaming.",
          cause: { limit, duration }
        });
      }
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
      yield* logInfo("Starting sync", {
        source: "jetstream",
        store: storeRef.name
      });
      const result = yield* Effect.gen(function* () {
        const engine = yield* JetstreamSyncEngine;
        const limitValue = Option.getOrUndefined(limit);
        const durationValue = Option.getOrUndefined(parsedDuration);
        const maxErrorsValue = Option.getOrUndefined(maxErrors);
        return yield* engine.sync({
          source: selection.source,
          store: storeRef,
          filter: expr,
          command: "sync jetstream",
          ...(limitValue !== undefined ? { limit: limitValue } : {}),
          ...(durationValue !== undefined ? { duration: durationValue } : {}),
          ...(selection.cursor !== undefined ? { cursor: selection.cursor } : {}),
          ...(strict ? { strict } : {}),
          ...(maxErrorsValue !== undefined ? { maxErrors: maxErrorsValue } : {})
        });
      }).pipe(
        Effect.provide(engineLayer),
        Effect.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
      );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      const totalPosts = yield* index.count(storeRef);
      yield* logInfo("Sync complete", { source: "jetstream", store: storeRef.name });
      yield* writeJson({ ...(result as SyncResult), totalPosts });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync Jetstream events into a store (posts only)",
      [
        "skygent sync jetstream --store my-store --limit 500",
        "skygent sync jetstream --store my-store --duration \"2 minutes\""
      ],
      ["Tip: use watch jetstream for continuous streaming."]
    )
  )
);

export const syncCommand = Command.make("sync", {}).pipe(
  Command.withSubcommands([
    timelineCommand,
    feedCommand,
    listCommand,
    notificationsCommand,
    authorCommand,
    threadCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Sync content into stores", [
      "skygent sync timeline --store my-store"
    ])
  )
);

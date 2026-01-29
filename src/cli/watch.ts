import { Command, Options } from "@effect/cli";
import { Effect, Layer, Option, Stream } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { DataSource } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { StoreLock } from "../services/store-lock.js";
import { makeWatchCommandBody } from "./sync-factory.js";
import { CliInputError } from "./errors.js";
import {
  feedUriArg,
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
  maxErrorsOption,
  parseMaxErrors
} from "./shared-options.js";

const intervalOption = Options.text("interval").pipe(
  Options.withDescription(
    "Polling interval (e.g. \"30 seconds\", \"500 millis\") (default: 30 seconds)"
  ),
  Options.optional
);
const depthOption = Options.integer("depth").pipe(
  Options.withDescription("Thread reply depth to include (0-1000, default 6)"),
  Options.optional
);
const parentHeightOption = Options.integer("parent-height").pipe(
  Options.withDescription("Thread parent height to include (0-1000, default 80)"),
  Options.optional
);

const parseBoundedIntOption = (
  value: Option.Option<number>,
  name: string,
  min: number,
  max: number
) =>
  Option.match(value, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) =>
      raw < min || raw > max
        ? Effect.fail(
            CliInputError.make({
              message: `${name} must be between ${min} and ${max}.`,
              cause: raw
            })
          )
        : Effect.succeed(Option.some(raw))
  });

const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  makeWatchCommandBody("timeline", () => DataSource.timeline())
).pipe(
  Command.withDescription(
    withExamples(
      "Watch timeline updates and emit sync results",
      [
        "skygent watch timeline --store my-store",
        "skygent watch timeline --store my-store --interval \"5 minutes\" --quiet"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const feedCommand = Command.make(
  "feed",
  {
    uri: feedUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ uri, ...rest }) => makeWatchCommandBody("feed", () => DataSource.feed(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a feed URI and emit sync results",
      [
        "skygent watch feed at://did:plc:example/app.bsky.feed.generator/xyz --store my-store --interval \"2 minutes\""
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const notificationsCommand = Command.make(
  "notifications",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  makeWatchCommandBody("notifications", () => DataSource.notifications())
).pipe(
  Command.withDescription(
    withExamples(
      "Watch notifications and emit sync results",
      ["skygent watch notifications --store my-store --interval \"1 minute\" --quiet"],
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
    interval: intervalOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, interval, store, quiet, refresh }) =>
    Effect.gen(function* () {
      const apiFilter = Option.getOrUndefined(filter);
      const source = DataSource.author(actor, {
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      const run = makeWatchCommandBody("author", () => source, {
        actor,
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      return yield* run({
        store,
        filter: postFilter,
        filterJson: postFilterJson,
        interval,
        quiet,
        refresh
      });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch an author's feed and emit sync results",
      [
        "skygent watch author alice.bsky.social --store my-store",
        "skygent watch author did:plc:example --store my-store --filter posts_no_replies --include-pins"
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
    interval: intervalOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, interval, store, quiet, refresh }) =>
    Effect.gen(function* () {
      const parsedDepth = yield* parseBoundedIntOption(depth, "depth", 0, 1000);
      const parsedParentHeight = yield* parseBoundedIntOption(
        parentHeight,
        "parent-height",
        0,
        1000
      );
      const depthValue = Option.getOrUndefined(parsedDepth);
      const parentHeightValue = Option.getOrUndefined(parsedParentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeWatchCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({ store, filter, filterJson, interval, quiet, refresh });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a thread and emit sync results",
      [
        "skygent watch thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store",
        "skygent watch thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store --depth 10 --parent-height 5"
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
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
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
      const parsedMaxErrors = yield* parseMaxErrors(maxErrors);
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
          yield* logInfo("Starting watch", { source: "jetstream", store: storeRef.name });
          yield* Effect.gen(function* () {
            const engine = yield* JetstreamSyncEngine;
            const maxErrorsValue = Option.getOrUndefined(parsedMaxErrors);
            const stream = engine.watch({
              source: selection.source,
              store: storeRef,
              filter: expr,
              command: "watch jetstream",
              ...(selection.cursor !== undefined ? { cursor: selection.cursor } : {}),
              ...(strict ? { strict } : {}),
              ...(maxErrorsValue !== undefined ? { maxErrors: maxErrorsValue } : {})
            });
            const outputStream = stream.pipe(
              Stream.map((event) => event.result),
              Stream.provideService(
                SyncReporter,
                makeSyncReporter(quiet, monitor, output)
              )
            );
            return yield* writeJsonStream(outputStream);
          }).pipe(Effect.provide(engineLayer));
        })
      );
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch Jetstream updates and emit sync results (posts only)",
      [
        "skygent watch jetstream --store my-store",
        "skygent watch jetstream --store my-store --quiet"
      ],
      ["Tip: use --collections to override subscribed collections."]
    )
  )
);

export const watchCommand = Command.make("watch", {}).pipe(
  Command.withSubcommands([
    timelineCommand,
    feedCommand,
    notificationsCommand,
    authorCommand,
    threadCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Continuously sync and emit results", [
      "skygent watch timeline --store my-store --interval \"2 minutes\""
    ])
  )
);

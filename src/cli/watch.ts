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
import { makeWatchCommandBody } from "./sync-factory.js";
import { parseOptionalDuration } from "./interval.js";
import { CliInputError } from "./errors.js";
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
  decodeActor,
  quietOption,
  refreshOption,
  strictOption,
  maxErrorsOption,
  parseMaxErrors
} from "./shared-options.js";
import {
  depthOption as threadDepthOption,
  parentHeightOption as threadParentHeightOption,
  parseThreadDepth
} from "./thread-options.js";

const intervalOption = Options.text("interval").pipe(
  Options.withDescription(
    "Polling interval (e.g. \"30 seconds\", \"500 millis\") (default: 30 seconds)"
  ),
  Options.optional
);
const maxCyclesOption = Options.integer("max-cycles").pipe(
  Options.withDescription("Stop after N watch cycles"),
  Options.optional
);
const untilOption = Options.text("until").pipe(
  Options.withDescription("Stop after a duration (e.g. \"10 minutes\")"),
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
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
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
    maxCycles: maxCyclesOption,
    until: untilOption,
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

const listCommand = Command.make(
  "list",
  {
    uri: listUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ uri, ...rest }) => makeWatchCommandBody("list", () => DataSource.list(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a list feed URI and emit sync results",
      [
        "skygent watch list at://did:plc:example/app.bsky.graph.list/xyz --store my-store --interval \"2 minutes\""
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
    maxCycles: maxCyclesOption,
    until: untilOption,
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
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, interval, maxCycles, until, store, quiet, refresh }) =>
    Effect.gen(function* () {
      const resolvedActor = yield* decodeActor(actor);
      const apiFilter = Option.getOrUndefined(filter);
      const source = DataSource.author(resolvedActor, {
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      const run = makeWatchCommandBody("author", () => source, {
        actor: resolvedActor,
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      return yield* run({
        store,
        filter: postFilter,
        filterJson: postFilterJson,
        interval,
        maxCycles,
        until,
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
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, interval, maxCycles, until, store, quiet, refresh }) =>
    Effect.gen(function* () {
      const { depth: depthValue, parentHeight: parentHeightValue } =
        yield* parseThreadDepth(depth, parentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeWatchCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({ store, filter, filterJson, interval, maxCycles, until, quiet, refresh });
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
    maxCycles: maxCyclesOption,
    until: untilOption,
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
    maxCycles,
    until,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
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
      const parsedUntil = yield* parseOptionalDuration(until);
      const parsedMaxCycles = yield* Option.match(maxCycles, {
        onNone: () => Effect.succeed(Option.none<number>()),
        onSome: (value) =>
          value <= 0
            ? Effect.fail(
                CliInputError.make({
                  message: "--max-cycles must be a positive integer.",
                  cause: { maxCycles: value }
                })
              )
            : Effect.succeed(Option.some(value))
      });
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
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
        const limited = Option.isSome(parsedMaxCycles)
          ? outputStream.pipe(Stream.take(parsedMaxCycles.value))
          : outputStream;
        const timed = Option.isSome(parsedUntil)
          ? limited.pipe(Stream.interruptWhen(Effect.sleep(parsedUntil.value)))
          : limited;
        return yield* writeJsonStream(timed);
      }).pipe(Effect.provide(engineLayer));
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
    listCommand,
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

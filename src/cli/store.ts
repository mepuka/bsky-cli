import { Args, Command, Options } from "@effect/cli";
import { Chunk, Clock, Effect, Option, Schema } from "effect";
import { StoreManager } from "../services/store-manager.js";
import { AppConfigService } from "../services/app-config.js";
import { Terminal } from "@effect/platform";
import { StoreNotFound } from "../domain/errors.js";
import { ActorId, AtUri, Did, Handle, StoreName, Timestamp } from "../domain/primitives.js";
import {
  AuthorSource,
  FeedSource,
  JetstreamSource,
  ListSource,
  TimelineSource,
  storeSourceId
} from "../domain/store-sources.js";
import { EventMeta, PostDelete } from "../domain/events.js";
import { StoreConfig, StoreMetadata, StoreRef } from "../domain/store.js";
import type { StoreLineage } from "../domain/derivation.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { decodeJson } from "./parse.js";
import { writeJson, writeText } from "./output.js";
import { StoreCleaner } from "../services/store-cleaner.js";
import { LineageStore } from "../services/lineage-store.js";
import { CliInputError } from "./errors.js";
import { OutputManager } from "../services/output-manager.js";
import { formatStoreConfigHelp, formatStoreConfigParseError } from "./store-errors.js";
import { formatFilterExpr } from "../domain/filter-describe.js";
import { CliPreferences } from "./preferences.js";
import { StoreStats } from "../services/store-stats.js";
import { withExamples } from "./help.js";
import { resolveOutputFormat, treeTableJsonFormats } from "./output-format.js";
import { StoreRenamer } from "../services/store-renamer.js";
import { PositiveInt } from "./option-schemas.js";
import { StoreSources } from "../services/store-sources.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreCommitter } from "../services/store-commit.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { BskyClient } from "../services/bsky-client.js";
import {
  authorFeedFilterValues,
  filterJsonOption as sourceFilterJsonOption,
  postFilterJsonOption as sourcePostFilterJsonOption,
  postFilterOption as sourcePostFilterOption
} from "./shared-options.js";
import { actorArg } from "./shared-options.js";
import { parseOptionalFilterExpr } from "./filter-input.js";
import {
  cacheStatusForStore,
  cacheStoreImages,
  cacheSweepForStore,
  cacheTtlSweep,
  cleanImageCache
} from "./image-cache.js";
import {
  buildStoreTreeData,
  renderStoreTree,
  renderStoreTreeAnsi,
  renderStoreTreeJson,
  renderStoreTreeTable,
  type StoreTreeRenderOptions
} from "./store-tree.js";

const storeNameArg = Args.text({ name: "name" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Store name")
);
const storeRenameFromArg = Args.text({ name: "from" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Existing store name")
);
const storeRenameToArg = Args.text({ name: "to" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("New store name")
);
const storeSourceIdArg = Args.text({ name: "id" }).pipe(
  Args.withDescription("Source id (AuthorSource:did:..., FeedSource:at://..., ListSource:at://..., TimelineSource:timeline, JetstreamSource:jetstream)")
);
const pruneSourceOption = Options.boolean("prune").pipe(
  Options.withDescription("Remove existing posts for this author source")
);
const storeNameOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name")
);
const forceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Confirm destructive store deletion")
);
const filterNameOption = Options.text("filter").pipe(
  Options.withDescription("Filter spec name to materialize"),
  Options.optional
);
const treeFormatOption = Options.choice("format", treeTableJsonFormats).pipe(
  Options.withDescription("Output format for store tree (default: tree)"),
  Options.optional
);
const treeAnsiOption = Options.boolean("ansi").pipe(
  Options.withDescription("Enable ANSI color output for tree format")
);
const treeWidthOption = Options.integer("width").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Line width for tree rendering (enables wrapping)"),
  Options.optional
);
const cacheLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of posts to scan for images"),
  Options.optional
);
const cacheThumbnailsOption = Options.boolean("thumbnails").pipe(
  Options.withDescription("Include thumbnails when caching or counting images")
);
const cacheForceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Confirm image cache deletion")
);
const cacheSweepForceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Delete orphaned cache files (default: dry-run)")
);
const cacheTtlForceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Delete expired cache files (default: dry-run)")
);
const authorSortOption = Options.choice("sort", [
  "by-posts",
  "by-engagement",
  "by-last-active"
]).pipe(
  Options.withDescription("Sort authors (default: by-posts)"),
  Options.optional
);
const authorLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of authors to return"),
  Options.optional
);
const confirmYesOption = Options.boolean("yes").pipe(
  Options.withAlias("y"),
  Options.withDescription("Confirm destructive action without prompting")
);

const resolveAuthorHandle = (identifier: string) =>
  Effect.gen(function* () {
    const identities = yield* IdentityResolver;
    const info = yield* identities.resolveIdentity(identifier).pipe(
      Effect.mapError((error) =>
        CliInputError.make({
          message: `Failed to resolve author: ${error.message}`,
          cause: error
        })
      )
    );
    return info.handle;
  });

const pruneAuthorPosts = (storeRef: StoreRef, handle: Handle, command: string) =>
  Effect.gen(function* () {
    const index = yield* StoreIndex;
    const committer = yield* StoreCommitter;
    const uris = yield* index.getByAuthor(storeRef, handle);
    if (uris.length === 0) {
      return 0;
    }
    const createdAt = yield* Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())
      )
    );
    const meta = EventMeta.make({
      source: "author",
      command,
      createdAt
    });
    yield* Effect.forEach(
      uris,
      (uri) => committer.appendDelete(storeRef, PostDelete.make({ uri, meta })),
      { discard: true }
    );
    return uris.length;
  });

const sourceAuthorOption = Options.text("author").pipe(
  Options.withSchema(ActorId),
  Options.withDescription("Author handle or DID"),
  Options.optional
);
const sourceFeedOption = Options.text("feed").pipe(
  Options.withSchema(AtUri),
  Options.withDescription("Bluesky feed URI (at://...)"),
  Options.optional
);
const sourceListOption = Options.text("list").pipe(
  Options.withSchema(AtUri),
  Options.withDescription("Bluesky list URI (at://...)"),
  Options.optional
);
const sourceTimelineOption = Options.boolean("timeline").pipe(
  Options.withDescription("Use the authenticated timeline source")
);
const sourceJetstreamOption = Options.boolean("jetstream").pipe(
  Options.withDescription("Use the Jetstream firehose source")
);
const sourceFilterOption = Options.text("filter").pipe(
  Options.withDescription(
    "Source filter (author: posts_no_replies, posts_with_replies, posts_with_media, posts_and_author_threads; feed/list: filter DSL)"
  ),
  Options.optional
);
const sourceExpandMembersOption = Options.boolean("expand-members").pipe(
  Options.withDescription("Expand list members into author sources (when supported)")
);

const configJsonOption = Options.text("config-json").pipe(
  Options.withDescription(
    "Store config as JSON string (materialized view filters, not sync filters)"
  ),
  Options.optional
);

const parseConfig = (configJson: Option.Option<string>) =>
  Option.match(configJson, {
    onNone: () => Effect.succeed(defaultStoreConfig),
    onSome: (raw) =>
      decodeJson(StoreConfig, raw, {
        formatter: formatStoreConfigParseError
      })
  });

const loadStoreRef = (name: StoreName) =>
  Effect.gen(function* () {
    const manager = yield* StoreManager;
    const store = yield* manager.getStore(name);
    return yield* Option.match(store, {
      onNone: () => Effect.fail(StoreNotFound.make({ name })),
      onSome: Effect.succeed
    });
  });

const loadStoreConfig = (name: StoreName) =>
  Effect.gen(function* () {
    const manager = yield* StoreManager;
    const config = yield* manager.getConfig(name);
    return Option.getOrElse(config, () => defaultStoreConfig);
  });

const compactLineage = (store: StoreRef, lineage: StoreLineage | undefined) => {
  if (!lineage) {
    return { store: store.name, derived: false, status: "ready" };
  }
  if (!lineage.isDerived || lineage.sources.length === 0) {
    return {
      store: store.name,
      derived: lineage.isDerived,
      status: lineage.isDerived ? "derived" : "ready",
      updatedAt: lineage.updatedAt.toISOString()
    };
  }
  const sources = lineage.sources.map((source) => ({
    store: source.storeName,
    filter: formatFilterExpr(source.filter),
    mode: source.evaluationMode,
    derivedAt: source.derivedAt.toISOString()
  }));
  const base = {
    store: store.name,
    derived: true,
    status: "derived",
    updatedAt: lineage.updatedAt.toISOString()
  };
  if (sources.length === 1) {
    const source = sources[0]!;
    return {
      ...base,
      source: source.store,
      filter: source.filter,
      mode: source.mode
    };
  }
  return { ...base, sources };
};

type SourceSelection =
  | { _tag: "author"; actor: ActorId }
  | { _tag: "feed"; uri: AtUri }
  | { _tag: "list"; uri: AtUri }
  | { _tag: "timeline" }
  | { _tag: "jetstream" };

const selectSource = (
  author: Option.Option<ActorId>,
  feed: Option.Option<AtUri>,
  list: Option.Option<AtUri>,
  timeline: boolean,
  jetstream: boolean
) => {
  const selected: Array<SourceSelection> = [];
  if (Option.isSome(author)) {
    selected.push({ _tag: "author", actor: author.value });
  }
  if (Option.isSome(feed)) {
    selected.push({ _tag: "feed", uri: feed.value });
  }
  if (Option.isSome(list)) {
    selected.push({ _tag: "list", uri: list.value });
  }
  if (timeline) {
    selected.push({ _tag: "timeline" });
  }
  if (jetstream) {
    selected.push({ _tag: "jetstream" });
  }

  const selectionSummary = {
    author: Option.isSome(author),
    feed: Option.isSome(feed),
    list: Option.isSome(list),
    timeline,
    jetstream
  };

  if (selected.length === 0) {
    return Effect.fail(
      CliInputError.make({
        message: "Provide one of --author, --feed, --list, --timeline, or --jetstream.",
        cause: selectionSummary
      })
    );
  }
  if (selected.length > 1) {
    return Effect.fail(
      CliInputError.make({
        message: "Use only one of --author, --feed, --list, --timeline, or --jetstream.",
        cause: selectionSummary
      })
    );
  }
  return Effect.succeed(selected[0]!);
};

const validateDslFilters = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) => parseOptionalFilterExpr(filter, filterJson).pipe(Effect.asVoid);

export const storeCreate = Command.make(
  "create",
  { name: storeNameArg, config: configJsonOption },
  ({ name, config }) =>
    Effect.gen(function* () {
      const manager = yield* StoreManager;
      const parsed = yield* parseConfig(config);
      const store = yield* manager.createStore(name, parsed);
      yield* writeJson(store);
    })
).pipe(
  Command.withDescription(
    withExamples("Create or load a store", [
      "skygent store create my-store",
      "skygent store create my-store --config-json '{\"filters\":[]}'"
    ])
  )
);

export const storeList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const manager = yield* StoreManager;
    const preferences = yield* CliPreferences;
    const stores = yield* manager.listStores();
    if (preferences.compact) {
      const names = Chunk.toReadonlyArray(stores).map((store) => store.name);
      yield* writeJson(names);
      return;
    }
    yield* writeJson(Chunk.toReadonlyArray(stores) as ReadonlyArray<StoreMetadata>);
  })
).pipe(
  Command.withDescription(
    withExamples("List known stores", [
      "skygent store list",
      "skygent store list --compact"
    ])
  )
);

export const storeShow = Command.make(
  "show",
  { name: storeNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const manager = yield* StoreManager;
      const lineageStore = yield* LineageStore;
      const preferences = yield* CliPreferences;
      const store = yield* loadStoreRef(name);
      const config = yield* manager.getConfig(name);
      const lineageOption = yield* lineageStore.get(name);

      if (preferences.compact) {
        const lineage = Option.getOrUndefined(lineageOption);
        yield* writeJson(compactLineage(store, lineage));
        return;
      }

      const output = Option.match(config, {
        onNone: () => ({ store }),
        onSome: (value) => ({ store, config: value })
      });

      const finalOutput = Option.match(lineageOption, {
        onNone: () => output,
        onSome: (lineage) => ({ ...output, lineage })
      });

      yield* writeJson(finalOutput);
    })
).pipe(
  Command.withDescription(
    withExamples("Show store config and metadata", [
      "skygent store show my-store",
      "skygent store show my-store --compact"
    ])
  )
);

export const storeSources = Command.make(
  "sources",
  { name: storeNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const sources = yield* StoreSources;
      const preferences = yield* CliPreferences;
      const storeRef = yield* loadStoreRef(name);
      const entries = yield* sources.list(storeRef);

      if (preferences.compact) {
        const ids = entries.map((source) => storeSourceId(source));
        yield* writeJson(ids);
        return;
      }

      const output = entries.map((source) => ({
        id: storeSourceId(source),
        source
      }));
      yield* writeJson(output);
    })
).pipe(
  Command.withDescription(
    withExamples("List configured sources for a store", [
      "skygent store sources my-store"
    ])
  )
);

export const storeAddSource = Command.make(
  "add-source",
  {
    name: storeNameArg,
    author: sourceAuthorOption,
    feed: sourceFeedOption,
    list: sourceListOption,
    timeline: sourceTimelineOption,
    jetstream: sourceJetstreamOption,
    filter: sourceFilterOption,
    filterJson: sourceFilterJsonOption,
    postFilter: sourcePostFilterOption,
    postFilterJson: sourcePostFilterJsonOption,
    expandMembers: sourceExpandMembersOption
  },
  ({ name, author, feed, list, timeline, jetstream, filter, filterJson, postFilter, postFilterJson, expandMembers }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const storeSources = yield* StoreSources;
      const selection = yield* selectSource(author, feed, list, timeline, jetstream);
      const hasFilter = Option.isSome(filter) || Option.isSome(filterJson);
      const hasPostFilter = Option.isSome(postFilter) || Option.isSome(postFilterJson);

      if (selection._tag !== "list" && expandMembers) {
        return yield* CliInputError.make({
          message: "--expand-members is only supported for list sources.",
          cause: { expandMembers }
        });
      }

      if (selection._tag !== "author" && hasPostFilter) {
        return yield* CliInputError.make({
          message: "--post-filter and --post-filter-json are only supported for author sources.",
          cause: { postFilter: Option.isSome(postFilter), postFilterJson: Option.isSome(postFilterJson) }
        });
      }

      if ((selection._tag === "timeline" || selection._tag === "jetstream") && (hasFilter || hasPostFilter || expandMembers)) {
        return yield* CliInputError.make({
          message: "Timeline and jetstream sources do not support filters or list options.",
          cause: {
            filter: Option.isSome(filter),
            filterJson: Option.isSome(filterJson),
            postFilter: Option.isSome(postFilter),
            postFilterJson: Option.isSome(postFilterJson),
            expandMembers
          }
        });
      }

      const now = new Date();
      const addedAt = yield* Schema.decodeUnknown(Timestamp)(now).pipe(Effect.orDie);

      switch (selection._tag) {
        case "author": {
          if (Option.isSome(filterJson)) {
            return yield* CliInputError.make({
              message: "--filter-json is not supported for author sources.",
              cause: { filterJson: filterJson.value }
            });
          }
          const apiFilter = Option.getOrUndefined(filter);
          if (
            apiFilter !== undefined &&
            !authorFeedFilterValues.includes(apiFilter as (typeof authorFeedFilterValues)[number])
          ) {
            return yield* CliInputError.make({
              message: `Invalid author filter: ${apiFilter}`,
              cause: { filter: apiFilter, validTags: authorFeedFilterValues }
            });
          }

          const authorFilter =
            apiFilter !== undefined
              ? (apiFilter as (typeof authorFeedFilterValues)[number])
              : undefined;

          yield* validateDslFilters(postFilter, postFilterJson);

          const identities = yield* IdentityResolver;
          const actorInput = selection.actor;
          const resolved = actorInput.startsWith("did:")
            ? {
                did: yield* Schema.decodeUnknown(Did)(actorInput).pipe(Effect.orDie),
                handle: undefined
              }
            : yield* identities.resolveIdentity(actorInput).pipe(
                Effect.mapError((error) =>
                  CliInputError.make({
                    message: `Failed to resolve author: ${error.message}`,
                    cause: error
                  })
                )
              );

          const source = AuthorSource.make({
            actor: resolved.did,
            ...(resolved.handle ? { display: resolved.handle } : {}),
            ...(authorFilter !== undefined ? { filter: authorFilter } : {}),
            ...(Option.isSome(postFilter) ? { postFilter: postFilter.value } : {}),
            ...(Option.isSome(postFilterJson) ? { postFilterJson: postFilterJson.value } : {}),
            addedAt,
            enabled: true
          });

          const stored = yield* storeSources.add(storeRef, source);
          yield* writeJson({
            store: storeRef.name,
            id: storeSourceId(stored),
            source: stored
          });
          return;
        }
        case "feed": {
          if (expandMembers) {
            return yield* CliInputError.make({
              message: "--expand-members is only supported for list sources.",
              cause: { expandMembers }
            });
          }

          yield* validateDslFilters(filter, filterJson);

          const client = yield* BskyClient;
          const warning = yield* client.getFeedGenerator(selection.uri).pipe(
            Effect.as(Option.none<string>()),
            Effect.catchTag("BskyError", (error) => Effect.succeed(Option.some(error.message)))
          );

          const source = FeedSource.make({
            uri: selection.uri,
            ...(Option.isSome(filter) ? { filter: filter.value } : {}),
            ...(Option.isSome(filterJson) ? { filterJson: filterJson.value } : {}),
            addedAt,
            enabled: true
          });

          const stored = yield* storeSources.add(storeRef, source);
          yield* writeJson({
            store: storeRef.name,
            id: storeSourceId(stored),
            source: stored,
            ...(Option.isSome(warning) ? { warning: warning.value } : {})
          });
          return;
        }
        case "list": {
          yield* validateDslFilters(filter, filterJson);

          const client = yield* BskyClient;
          const warning = yield* client.getList(selection.uri).pipe(
            Effect.as(Option.none<string>()),
            Effect.catchTag("BskyError", (error) => Effect.succeed(Option.some(error.message)))
          );

          const source = ListSource.make({
            uri: selection.uri,
            expandMembers,
            ...(Option.isSome(filter) ? { filter: filter.value } : {}),
            ...(Option.isSome(filterJson) ? { filterJson: filterJson.value } : {}),
            addedAt,
            enabled: true
          });

          const stored = yield* storeSources.add(storeRef, source);
          yield* writeJson({
            store: storeRef.name,
            id: storeSourceId(stored),
            source: stored,
            ...(Option.isSome(warning) ? { warning: warning.value } : {})
          });
          return;
        }
        case "timeline": {
          const source = TimelineSource.make({
            addedAt,
            enabled: true
          });
          const stored = yield* storeSources.add(storeRef, source);
          yield* writeJson({
            store: storeRef.name,
            id: storeSourceId(stored),
            source: stored
          });
          return;
        }
        case "jetstream": {
          const source = JetstreamSource.make({
            addedAt,
            enabled: true
          });
          const stored = yield* storeSources.add(storeRef, source);
          yield* writeJson({
            store: storeRef.name,
            id: storeSourceId(stored),
            source: stored
          });
          return;
        }
      }
    })
).pipe(
  Command.withDescription(
    withExamples("Add a source to a store", [
      "skygent store add-source my-store --author alice.bsky.social",
      "skygent store add-source my-store --feed at://did:plc:example/app.bsky.feed.generator/xyz",
      "skygent store add-source my-store --list at://did:plc:example/app.bsky.graph.list/abc",
      "skygent store add-source my-store --timeline"
    ])
  )
);

export const storeRemoveSource = Command.make(
  "remove-source",
  { name: storeNameArg, id: storeSourceIdArg, prune: pruneSourceOption },
  ({ name, id, prune }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const sources = yield* StoreSources;
      const existing = yield* sources.get(storeRef, id);
      if (Option.isNone(existing)) {
        return yield* CliInputError.make({
          message: `Unknown source id: ${id}`,
          cause: { id }
        });
      }
      let pruned = 0;
      if (prune) {
        const source = existing.value;
        if (source._tag !== "AuthorSource") {
          return yield* CliInputError.make({
            message: "--prune is only supported for author sources.",
            cause: { id, type: source._tag }
          });
        }
        const handle = source.display ?? (yield* resolveAuthorHandle(source.actor));
        pruned = yield* pruneAuthorPosts(
          storeRef,
          handle,
          "store remove-source --prune"
        );
      }
      yield* sources.remove(storeRef, id);
      yield* writeJson({
        store: storeRef.name,
        removed: id,
        ...(prune ? { pruned } : {})
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Remove a configured source from a store", [
      "skygent store remove-source my-store AuthorSource:did:plc:example",
      "skygent store remove-source my-store AuthorSource:did:plc:example --prune",
      "skygent store remove-source my-store TimelineSource:timeline"
    ])
  )
);

export const storeAuthors = Command.make(
  "authors",
  { name: storeNameArg, sort: authorSortOption, limit: authorLimitOption },
  ({ name, sort, limit }) =>
    Effect.gen(function* () {
      const stats = yield* StoreStats;
      const storeRef = yield* loadStoreRef(name);
      const sortValue = Option.getOrUndefined(sort);
      const limitValue = Option.getOrUndefined(limit);
      const sortKey =
        sortValue === "by-engagement"
          ? "engagement"
          : sortValue === "by-last-active"
            ? "lastActive"
            : "posts";
      const authors = yield* stats.authors(storeRef, {
        sort: sortKey,
        ...(limitValue !== undefined ? { limit: limitValue } : {})
      });
      yield* writeJson({ store: storeRef.name, authors });
    })
).pipe(
  Command.withDescription(
    withExamples("List authors for a store with stats", [
      "skygent store authors my-store",
      "skygent store authors my-store --sort by-engagement --limit 25"
    ])
  )
);

export const storeRemoveAuthor = Command.make(
  "remove-author",
  { name: storeNameArg, actor: actorArg, yes: confirmYesOption },
  ({ name, actor, yes }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      if (!yes) {
        const terminal = yield* Terminal.Terminal;
        const isTTY = yield* terminal.isTTY.pipe(Effect.orElseSucceed(() => false));
        if (!isTTY) {
          return yield* CliInputError.make({
            message: "--yes is required to remove an author without a TTY.",
            cause: { name, actor }
          });
        }
        yield* terminal.display(
          `Remove all posts by "${actor}" from store "${storeRef.name}"? [y/N] `
        );
        const response = yield* terminal.readLine.pipe(
          Effect.catchAll(() => Effect.succeed(""))
        );
        const normalized = response.trim().toLowerCase();
        const confirmed = normalized === "y" || normalized === "yes";
        if (!confirmed) {
          yield* writeJson({ store: storeRef.name, removed: 0, cancelled: true });
          return;
        }
      }

      const handle = yield* resolveAuthorHandle(actor);
      const removed = yield* pruneAuthorPosts(storeRef, handle, "store remove-author");
      yield* writeJson({ store: storeRef.name, author: handle, removed });
    })
).pipe(
  Command.withDescription(
    withExamples("Remove an author's posts from a store", [
      "skygent store remove-author my-store alice.bsky.social --yes",
      "skygent store remove-author my-store did:plc:example"
    ])
  )
);

export const storeDelete = Command.make(
  "delete",
  { name: storeNameArg, force: forceOption },
  ({ name, force }) =>
    Effect.gen(function* () {
      if (!force) {
        const terminal = yield* Terminal.Terminal;
        const isTTY = yield* terminal.isTTY.pipe(Effect.orElseSucceed(() => false));
        if (!isTTY) {
          return yield* CliInputError.make({
            message: "--force is required to delete a store.",
            cause: { name, force }
          });
        }

        yield* terminal.display(
          `Delete store "${name}" and all its data? [y/N] `
        );
        const response = yield* terminal.readLine.pipe(
          Effect.catchAll(() => Effect.succeed(""))
        );
        const normalized = response.trim().toLowerCase();
        const confirmed = normalized === "y" || normalized === "yes";
        if (!confirmed) {
          yield* writeJson({ deleted: false, reason: "cancelled" });
          return;
        }
      }
      const cleaner = yield* StoreCleaner;
      const result = yield* cleaner.deleteStore(name);
      if (!result.deleted) {
        if (result.reason === "missing") {
          yield* writeJson(result);
          return;
        }
        return yield* CliInputError.make({
          message: `Store "${name}" was not deleted.`,
          cause: result
        });
      }
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Delete a store and its data", [
      "skygent store delete my-store --force"
    ])
  )
);

export const storeRename = Command.make(
  "rename",
  { from: storeRenameFromArg, to: storeRenameToArg },
  ({ from, to }) =>
    Effect.gen(function* () {
      if (from === to) {
        return yield* CliInputError.make({
          message: "Old and new store names must be different.",
          cause: { from, to }
        });
      }
      const renamer = yield* StoreRenamer;
      const result = yield* renamer.rename(from, to);
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Rename a store", ["skygent store rename old-name new-name"])
  )
);

export const storeMaterialize = Command.make(
  "materialize",
  { name: storeNameArg, filter: filterNameOption },
  ({ name, filter }) =>
    Effect.gen(function* () {
      const manager = yield* StoreManager;
      const outputManager = yield* OutputManager;
      const storeRef = yield* loadStoreRef(name);
      const configOption = yield* manager.getConfig(name);
      const config = Option.getOrElse(configOption, () => defaultStoreConfig);

      if (config.filters.length === 0) {
        return yield* CliInputError.make({
          message: formatStoreConfigHelp(
            `Store "${name}" has no configured filters to materialize. Add filters to the store config.`
          ),
          cause: { store: name }
        });
      }

      const selected = yield* Option.match(filter, {
        onNone: () => Effect.succeed(config.filters),
        onSome: (filterName) => {
          const match = config.filters.find((spec) => spec.name === filterName);
          if (!match) {
            return Effect.fail(
              CliInputError.make({
                message: `Unknown filter spec: ${filterName}`,
                cause: { store: name, filter: filterName }
              })
            );
          }
          return Effect.succeed([match]);
        }
      });
      const results = yield* outputManager.materializeFilters(storeRef, selected);
      yield* writeJson({
        store: storeRef.name,
        filters: results
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Materialize configured filter outputs to disk", [
      "skygent store materialize my-store",
      "skygent store materialize my-store --filter ai-posts"
    ])
  )
);

export const storeStats = Command.make(
  "stats",
  { name: storeNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const stats = yield* StoreStats;
      const storeRef = yield* loadStoreRef(name);
      const result = yield* stats.stats(storeRef);
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Show summary stats for a store", [
      "skygent store stats my-store"
    ])
  )
);

export const storeSummary = Command.make("summary", {}, () =>
  Effect.gen(function* () {
    const stats = yield* StoreStats;
    const result = yield* stats.summary();
    yield* writeJson(result);
  })
).pipe(
  Command.withDescription(
    withExamples("Summarize all stores with counts and status", [
      "skygent store summary --compact"
    ])
  )
);

export const storeCache = Command.make(
  "cache",
  { name: storeNameArg, thumbnails: cacheThumbnailsOption, limit: cacheLimitOption },
  ({ name, thumbnails, limit }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const limitValue = Option.getOrUndefined(limit);
      const result = yield* cacheStoreImages(storeRef, {
        includeThumbnails: thumbnails,
        ...(limitValue !== undefined ? { limit: limitValue } : {})
      });
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Cache image embeds for a store", [
      "skygent store cache my-store",
      "skygent store cache my-store --thumbnails --limit 200"
    ])
  )
);

export const storeCacheStatus = Command.make(
  "cache-status",
  { name: storeNameArg, thumbnails: cacheThumbnailsOption, limit: cacheLimitOption },
  ({ name, thumbnails, limit }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const limitValue = Option.getOrUndefined(limit);
      const result = yield* cacheStatusForStore(storeRef, {
        includeThumbnails: thumbnails,
        ...(limitValue !== undefined ? { limit: limitValue } : {})
      });
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Report image cache coverage for a store", [
      "skygent store cache-status my-store",
      "skygent store cache-status my-store --thumbnails"
    ])
  )
);

export const storeCacheClean = Command.make(
  "cache-clean",
  { force: cacheForceOption },
  ({ force }) =>
    Effect.gen(function* () {
      const result = yield* cleanImageCache(force);
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples("Clear the image cache", [
      "skygent store cache-clean --force"
    ])
  )
);

export const storeCacheSweep = Command.make(
  "cache-sweep",
  { name: storeNameArg, thumbnails: cacheThumbnailsOption, force: cacheSweepForceOption },
  ({ name, thumbnails, force }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const result = yield* cacheSweepForStore(storeRef, {
        includeThumbnails: thumbnails,
        remove: force
      });
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sweep orphaned image cache files",
      [
        "skygent store cache-sweep my-store",
        "skygent store cache-sweep my-store --thumbnails --force"
      ],
      ["Tip: omit --force to run a dry sweep first."]
    )
  )
);

export const storeCacheTtlSweep = Command.make(
  "cache-ttl-sweep",
  { name: storeNameArg, thumbnails: cacheThumbnailsOption, force: cacheTtlForceOption },
  ({ name, thumbnails, force }) =>
    Effect.gen(function* () {
      const storeRef = yield* loadStoreRef(name);
      const result = yield* cacheTtlSweep({
        includeThumbnails: thumbnails,
        remove: force
      });
      yield* writeJson({ store: storeRef.name, ...result });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sweep expired image cache files (TTL-based)",
      [
        "skygent store cache-ttl-sweep my-store",
        "skygent store cache-ttl-sweep my-store --thumbnails --force"
      ],
      ["Tip: omit --force to run a dry sweep first."]
    )
  )
);

export const storeTree = Command.make(
  "tree",
  { format: treeFormatOption, ansi: treeAnsiOption, width: treeWidthOption },
  ({ format, ansi, width }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const data = yield* buildStoreTreeData;
      const outputFormat = resolveOutputFormat(
        format,
        appConfig.outputFormat,
        treeTableJsonFormats,
        "tree"
      );
      const renderOptions: StoreTreeRenderOptions | undefined = Option.match(width, {
        onNone: () => undefined,
        onSome: (value) => ({ width: value })
      });
      switch (outputFormat) {
        case "json":
          yield* writeJson(renderStoreTreeJson(data));
          return;
        case "table":
          yield* writeText(renderStoreTreeTable(data));
          return;
        default:
          yield* writeText(
            ansi ? renderStoreTreeAnsi(data, renderOptions) : renderStoreTree(data, renderOptions)
          );
      }
    })
).pipe(
  Command.withDescription(
    withExamples("Visualize store lineage as an ASCII tree", [
      "skygent store tree --format table",
      "skygent store tree --ansi --width 100"
    ])
  )
);

export const storeCommand = Command.make("store", {}).pipe(
  Command.withSubcommands([
    storeCreate,
    storeList,
    storeShow,
    storeSources,
    storeAddSource,
    storeRemoveSource,
    storeAuthors,
    storeRemoveAuthor,
    storeRename,
    storeDelete,
    storeMaterialize,
    storeStats,
    storeSummary,
    storeCache,
    storeCacheStatus,
    storeCacheClean,
    storeCacheSweep,
    storeCacheTtlSweep,
    storeTree
  ]),
  Command.withDescription(
    withExamples("Manage stores and lineage", [
      "skygent store list",
      "skygent store tree --format table"
    ])
  )
);

export const storeOptions = { storeNameOption, loadStoreRef, loadStoreConfig };

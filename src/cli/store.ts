import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option } from "effect";
import { StoreManager } from "../services/store-manager.js";
import { AppConfigService } from "../services/app-config.js";
import { Terminal } from "@effect/platform";
import { StoreNotFound } from "../domain/errors.js";
import { StoreName } from "../domain/primitives.js";
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
  Options.withDescription("Line width for tree rendering (enables wrapping)"),
  Options.optional
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
          return yield* CliInputError.make({
            message: `Store "${name}" was not deleted (cancelled by user).`,
            cause: { deleted: false, reason: "cancelled" }
          });
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
    storeRename,
    storeDelete,
    storeMaterialize,
    storeStats,
    storeSummary,
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

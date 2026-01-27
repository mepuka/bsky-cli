import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option } from "effect";
import { StoreManager } from "../services/store-manager.js";
import { StoreNotFound } from "../domain/errors.js";
import { StoreName } from "../domain/primitives.js";
import { StoreConfig, StoreMetadata } from "../domain/store.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { decodeJson } from "./parse.js";
import { writeJson } from "./output.js";
import { StoreCleaner } from "../services/store-cleaner.js";
import { LineageStore } from "../services/lineage-store.js";
import { CliInputError } from "./errors.js";
import { OutputManager } from "../services/output-manager.js";
import { formatStoreConfigParseError } from "./store-errors.js";

const storeNameArg = Args.text({ name: "name" }).pipe(Args.withSchema(StoreName));
const storeNameOption = Options.text("store").pipe(Options.withSchema(StoreName));
const forceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Confirm destructive store deletion")
);
const filterNameOption = Options.text("filter").pipe(
  Options.withDescription("Filter spec name to materialize"),
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
).pipe(Command.withDescription("Create or load a store"));

export const storeList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const manager = yield* StoreManager;
    const stores = yield* manager.listStores();
    yield* writeJson(Chunk.toReadonlyArray(stores) as ReadonlyArray<StoreMetadata>);
  })
).pipe(Command.withDescription("List known stores"));

export const storeShow = Command.make(
  "show",
  { name: storeNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const manager = yield* StoreManager;
      const lineageStore = yield* LineageStore;
      const store = yield* loadStoreRef(name);
      const config = yield* manager.getConfig(name);
      const lineageOption = yield* lineageStore.get(name);

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
).pipe(Command.withDescription("Show store config and metadata"));

export const storeDelete = Command.make(
  "delete",
  { name: storeNameArg, force: forceOption },
  ({ name, force }) =>
    Effect.gen(function* () {
      if (!force) {
        return yield* CliInputError.make({
          message: "--force is required to delete a store.",
          cause: { name, force }
        });
      }
      const cleaner = yield* StoreCleaner;
      const result = yield* cleaner.deleteStore(name);
      yield* writeJson(result);
    })
).pipe(Command.withDescription("Delete a store and its data"));

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
).pipe(Command.withDescription("Materialize configured filter outputs to disk"));

export const storeCommand = Command.make("store", {}).pipe(
  Command.withSubcommands([
    storeCreate,
    storeList,
    storeShow,
    storeDelete,
    storeMaterialize
  ])
);

export const storeOptions = { storeNameOption, loadStoreRef };

import { Args, Command, Options } from "@effect/cli";
import { Chunk, Effect, Option } from "effect";
import { StoreManager } from "../services/store-manager.js";
import { StoreNotFound } from "../domain/errors.js";
import { StoreName } from "../domain/primitives.js";
import { StoreConfig, StoreMetadata, StoreRef } from "../domain/store.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { decodeJson } from "./parse.js";
import { writeJson } from "./output.js";
import { StoreCleaner } from "../services/store-cleaner.js";

const storeNameArg = Args.text({ name: "name" }).pipe(Args.withSchema(StoreName));
const storeNameOption = Options.text("store").pipe(Options.withSchema(StoreName));

const configJsonOption = Options.text("config-json").pipe(
  Options.withDescription("Store config as JSON string"),
  Options.optional
);

const parseConfig = (configJson: Option.Option<string>) =>
  Option.match(configJson, {
    onNone: () => Effect.succeed(defaultStoreConfig),
    onSome: (raw) => decodeJson(StoreConfig, raw)
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
      const store = yield* loadStoreRef(name);
      const config = yield* manager.getConfig(name);
      const output = Option.match(config, {
        onNone: () => ({ store }),
        onSome: (value) => ({ store, config: value })
      });
      yield* writeJson(output as { store: StoreRef; config?: StoreConfig });
    })
).pipe(Command.withDescription("Show store config and metadata"));

export const storeDelete = Command.make(
  "delete",
  { name: storeNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const cleaner = yield* StoreCleaner;
      const result = yield* cleaner.deleteStore(name);
      yield* writeJson(result);
    })
).pipe(Command.withDescription("Delete a store and its data"));

export const storeCommand = Command.make("store", {}).pipe(
  Command.withSubcommands([storeCreate, storeList, storeShow, storeDelete])
);

export const storeOptions = { storeNameOption, loadStoreRef };

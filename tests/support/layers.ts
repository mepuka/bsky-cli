import { BunContext } from "@effect/platform-bun";
import { Layer } from "effect";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { CliPreferences } from "../../src/cli/preferences.js";
import { CliOutput } from "../../src/cli/output.js";

type AnyLayer = Layer.Layer<any, any, any>;

type AppConfigOverrides = {
  readonly service?: string;
  readonly storeRoot?: string;
  readonly outputFormat?: "json" | "ndjson" | "table" | "markdown" | "compact" | "card" | "thread" | "text" | "tree";
  readonly identifier?: string;
};

export const buildAppConfigLayer = (
  storeRoot: string,
  overrides: Omit<AppConfigOverrides, "storeRoot"> = {}
) => {
  const configOverrides = Layer.succeed(ConfigOverrides, {
    storeRoot,
    ...overrides
  });
  return AppConfigService.layer.pipe(
    Layer.provide(configOverrides),
    Layer.provide(BunContext.layer)
  );
};

export const buildStoreCoreLayer = (
  storeRoot: string,
  overrides: Omit<AppConfigOverrides, "storeRoot"> = {}
) => {
  const appConfigLayer = buildAppConfigLayer(storeRoot, overrides);
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

export const buildCliTestLayer = (args: {
  readonly storeRoot: string;
  readonly outputLayer: Layer.Layer<CliOutput>;
  readonly preferencesLayer?: Layer.Layer<CliPreferences>;
  readonly appConfigOverrides?: Omit<AppConfigOverrides, "storeRoot">;
  readonly extraLayers?: ReadonlyArray<AnyLayer>;
}) => {
  const base = buildStoreCoreLayer(args.storeRoot, args.appConfigOverrides);
  const preferencesLayer =
    args.preferencesLayer ?? Layer.succeed(CliPreferences, { compact: false });
  const extras =
    args.extraLayers?.map((layer) => layer.pipe(Layer.provideMerge(base))) ?? [];

  return Layer.mergeAll(
    base,
    args.outputLayer,
    preferencesLayer,
    ...extras
  );
};

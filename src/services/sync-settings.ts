import { Config, Effect } from "effect";
import { pickDefined, validatePositive, validateNonNegative } from "./shared.js";

export type SyncSettingsValue = {
  readonly checkpointEvery: number;
  readonly checkpointIntervalMs: number;
  readonly concurrency: number;
  readonly batchSize: number;
  readonly pageLimit: number;
};

type SyncSettingsOverridesValue = Partial<SyncSettingsValue>;



export class SyncSettingsOverrides extends Effect.Service<SyncSettingsOverrides>()("@skygent/SyncSettingsOverrides", {
  succeed: {} as SyncSettingsOverridesValue
}) {
  static readonly layer = SyncSettingsOverrides.Default;
}

export class SyncSettings extends Effect.Service<SyncSettings>()("@skygent/SyncSettings", {
  effect: Effect.gen(function* () {
    const { _tag: _, ...overrides } = yield* SyncSettingsOverrides;

    const checkpointEvery = yield* Config.integer("SKYGENT_SYNC_CHECKPOINT_EVERY").pipe(
      Config.withDefault(100)
    );
    const checkpointIntervalMs = yield* Config.integer(
      "SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS"
    ).pipe(Config.withDefault(5000));
    const concurrency = yield* Config.integer("SKYGENT_SYNC_CONCURRENCY").pipe(
      Config.withDefault(5)
    );
    const batchSize = yield* Config.integer("SKYGENT_SYNC_BATCH_SIZE").pipe(
      Config.withDefault(100)
    );
    const pageLimit = yield* Config.integer("SKYGENT_SYNC_PAGE_LIMIT").pipe(
      Config.withDefault(100)
    );

    const merged = {
      checkpointEvery,
      checkpointIntervalMs,
      concurrency,
      batchSize,
      pageLimit,
      ...pickDefined(overrides as Record<string, unknown>)
    } as SyncSettingsValue;

    const checkpointEveryError = validatePositive(
      "SKYGENT_SYNC_CHECKPOINT_EVERY",
      merged.checkpointEvery
    );
    if (checkpointEveryError) {
      return yield* checkpointEveryError;
    }
    const checkpointIntervalError = validateNonNegative(
      "SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS",
      merged.checkpointIntervalMs
    );
    if (checkpointIntervalError) {
      return yield* checkpointIntervalError;
    }
    const concurrencyError = validatePositive(
      "SKYGENT_SYNC_CONCURRENCY",
      merged.concurrency
    );
    if (concurrencyError) {
      return yield* concurrencyError;
    }
    const batchSizeError = validatePositive(
      "SKYGENT_SYNC_BATCH_SIZE",
      merged.batchSize
    );
    if (batchSizeError) {
      return yield* batchSizeError;
    }
    const pageLimitError = validatePositive(
      "SKYGENT_SYNC_PAGE_LIMIT",
      merged.pageLimit
    );
    if (pageLimitError) {
      return yield* pageLimitError;
    }

    return merged;
  })
}) {
  static readonly layer = SyncSettings.Default;
}

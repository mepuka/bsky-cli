import { Config, Context, Effect, Layer } from "effect";
import { ConfigError } from "../domain/errors.js";

export type SyncSettingsValue = {
  readonly checkpointEvery: number;
  readonly checkpointIntervalMs: number;
  readonly concurrency: number;
};

type SyncSettingsOverridesValue = Partial<SyncSettingsValue>;

const pickDefined = <T extends Record<string, unknown>>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;

const validatePositive = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 1) {
    return ConfigError.make({ message: `${name} must be >= 1.` });
  }
};

const validateNonNegative = (name: string, value: number) => {
  if (!Number.isFinite(value) || value < 0) {
    return ConfigError.make({ message: `${name} must be >= 0.` });
  }
};

export class SyncSettingsOverrides extends Context.Tag("@skygent/SyncSettingsOverrides")<
  SyncSettingsOverrides,
  SyncSettingsOverridesValue
>() {
  static readonly layer = Layer.succeed(SyncSettingsOverrides, {});
}

export class SyncSettings extends Context.Tag("@skygent/SyncSettings")<
  SyncSettings,
  SyncSettingsValue
>() {
  static readonly layer = Layer.effect(
    SyncSettings,
    Effect.gen(function* () {
      const overrides = yield* SyncSettingsOverrides;

      const checkpointEvery = yield* Config.integer("SKYGENT_SYNC_CHECKPOINT_EVERY").pipe(
        Config.withDefault(100)
      );
      const checkpointIntervalMs = yield* Config.integer(
        "SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS"
      ).pipe(Config.withDefault(5000));
      const concurrency = yield* Config.integer("SKYGENT_SYNC_CONCURRENCY").pipe(
        Config.withDefault(5)
      );

      const merged = {
        checkpointEvery,
        checkpointIntervalMs,
        concurrency,
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

      return SyncSettings.of(merged);
    })
  );
}

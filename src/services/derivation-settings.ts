import { Config, Context, Effect, Layer, Option } from "effect";
import { ConfigError } from "../domain/errors.js";

export type DerivationSettingsValue = {
  readonly checkpointEvery: number;
  readonly checkpointIntervalMs: number;
};

type DerivationSettingsOverridesValue = Partial<DerivationSettingsValue>;

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

export class DerivationSettingsOverrides extends Context.Tag(
  "@skygent/DerivationSettingsOverrides"
)<DerivationSettingsOverrides, DerivationSettingsOverridesValue>() {
  static readonly layer = Layer.succeed(DerivationSettingsOverrides, {});
}

export class DerivationSettings extends Context.Tag("@skygent/DerivationSettings")<
  DerivationSettings,
  DerivationSettingsValue
>() {
  static readonly layer = Layer.effect(
    DerivationSettings,
    Effect.gen(function* () {
      const overrides = yield* Effect.serviceOption(DerivationSettingsOverrides).pipe(
        Effect.map(Option.getOrElse(() => ({} as DerivationSettingsOverridesValue)))
      );

      const checkpointEvery = yield* Config.integer(
        "SKYGENT_DERIVATION_CHECKPOINT_EVERY"
      ).pipe(Config.withDefault(100));
      const checkpointIntervalMs = yield* Config.integer(
        "SKYGENT_DERIVATION_CHECKPOINT_INTERVAL_MS"
      ).pipe(Config.withDefault(5000));

      const merged = {
        checkpointEvery,
        checkpointIntervalMs,
        ...pickDefined(overrides as Record<string, unknown>)
      } as DerivationSettingsValue;

      const checkpointEveryError = validatePositive(
        "SKYGENT_DERIVATION_CHECKPOINT_EVERY",
        merged.checkpointEvery
      );
      if (checkpointEveryError) {
        return yield* checkpointEveryError;
      }
      const checkpointIntervalError = validateNonNegative(
        "SKYGENT_DERIVATION_CHECKPOINT_INTERVAL_MS",
        merged.checkpointIntervalMs
      );
      if (checkpointIntervalError) {
        return yield* checkpointIntervalError;
      }

      return DerivationSettings.of(merged);
    })
  );
}

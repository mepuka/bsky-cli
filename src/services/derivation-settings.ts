import { Config, Effect, Option } from "effect";
import { pickDefined, validatePositive, validateNonNegative } from "./shared.js";

export type DerivationSettingsValue = {
  readonly checkpointEvery: number;
  readonly checkpointIntervalMs: number;
};

type DerivationSettingsOverridesValue = Partial<DerivationSettingsValue>;



export class DerivationSettingsOverrides extends Effect.Service<DerivationSettingsOverrides>()("@skygent/DerivationSettingsOverrides", {
  succeed: {} as DerivationSettingsOverridesValue
}) {
  static readonly layer = DerivationSettingsOverrides.Default;
}

export class DerivationSettings extends Effect.Service<DerivationSettings>()("@skygent/DerivationSettings", {
  effect: Effect.gen(function* () {
    const overrides = yield* Effect.serviceOption(DerivationSettingsOverrides).pipe(
      Effect.map(Option.match({
        onNone: () => ({} as DerivationSettingsOverridesValue),
        onSome: ({ _tag: _, ...rest }) => rest as DerivationSettingsOverridesValue
      }))
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

    return merged;
  })
}) {
  static readonly layer = DerivationSettings.Default;
}

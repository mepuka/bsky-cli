import { Config, Context, Effect, Layer, Option } from "effect";
import { pickDefined, validatePositive, validateNonNegative } from "./shared.js";

export type DerivationSettingsValue = {
  readonly checkpointEvery: number;
  readonly checkpointIntervalMs: number;
};

type DerivationSettingsOverridesValue = Partial<DerivationSettingsValue>;



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

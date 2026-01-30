import { Config, Context, Effect, Layer } from "effect";
import { validatePositive } from "./shared.js";

export type FilterSettingsValue = {
  readonly concurrency: number;
};

export class FilterSettings extends Context.Tag("@skygent/FilterSettings")<
  FilterSettings,
  FilterSettingsValue
>() {
  static readonly layer = Layer.effect(
    FilterSettings,
    Effect.gen(function* () {
      const concurrency = yield* Config.integer("SKYGENT_FILTER_CONCURRENCY").pipe(
        Config.withDefault(10)
      );

      const concurrencyError = validatePositive(
        "SKYGENT_FILTER_CONCURRENCY",
        concurrency
      );
      if (concurrencyError) {
        return yield* concurrencyError;
      }

      return FilterSettings.of({ concurrency });
    })
  );
}

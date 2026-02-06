import { Config, Effect } from "effect";
import { validatePositive } from "./shared.js";

export type FilterSettingsValue = {
  readonly concurrency: number;
};

export class FilterSettings extends Effect.Service<FilterSettings>()("@skygent/FilterSettings", {
  effect: Effect.gen(function* () {
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

    return { concurrency };
  })
}) {
  static readonly layer = FilterSettings.Default;
}

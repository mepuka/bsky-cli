import { Context } from "effect";

export type CliPreferencesValue = {
  readonly compact: boolean;
};

export class CliPreferences extends Context.Tag("@skygent/CliPreferences")<
  CliPreferences,
  CliPreferencesValue
>() {}

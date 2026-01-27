import { Context } from "effect";

export type CliPreferencesValue = {
  readonly compact: boolean;
  readonly logFormat?: "json" | "human";
};

export class CliPreferences extends Context.Tag("@skygent/CliPreferences")<
  CliPreferences,
  CliPreferencesValue
>() {}

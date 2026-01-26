import { Options } from "@effect/cli";
import { Option } from "effect";
import { OutputFormat } from "../domain/config.js";
import { AppConfig } from "../domain/config.js";

const pickDefined = <T extends Record<string, unknown>>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;

export const configOptions = {
  service: Options.text("service").pipe(
    Options.optional,
    Options.withDescription("Override the Bluesky service URL")
  ),
  storeRoot: Options.text("store-root").pipe(
    Options.optional,
    Options.withDescription("Override the root storage directory")
  ),
  outputFormat: Options.choice("output-format", [
    "json",
    "ndjson",
    "markdown",
    "table"
  ]).pipe(Options.optional, Options.withDescription("Default output format")),
  identifier: Options.text("identifier").pipe(
    Options.optional,
    Options.withDescription("Override Bluesky identifier")
  ),
  password: Options.text("password").pipe(
    Options.optional,
    Options.withDescription("Override Bluesky password")
  )
};

export type ConfigOptions = {
  readonly service: Option.Option<string>;
  readonly storeRoot: Option.Option<string>;
  readonly outputFormat: Option.Option<OutputFormat>;
  readonly identifier: Option.Option<string>;
  readonly password: Option.Option<string>;
};

export const toConfigOverrides = (options: ConfigOptions): Partial<AppConfig> =>
  pickDefined({
    service: Option.getOrUndefined(options.service),
    storeRoot: Option.getOrUndefined(options.storeRoot),
    outputFormat: Option.getOrUndefined(options.outputFormat),
    identifier: Option.getOrUndefined(options.identifier),
    password: Option.getOrUndefined(options.password)
  }) as Partial<AppConfig>;

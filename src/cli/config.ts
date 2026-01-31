import { Options } from "@effect/cli";
import { Option, Redacted } from "effect";
import { pickDefined } from "../services/shared.js";
import { OutputFormat } from "../domain/config.js";
import { AppConfig } from "../domain/config.js";
import type { LogFormat } from "./logging.js";
import type { SyncSettingsValue } from "../services/sync-settings.js";
import type { CredentialsOverridesValue } from "../services/credential-store.js";


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
  password: Options.redacted("password").pipe(
    Options.optional,
    Options.withDescription("Override Bluesky password (redacted)")
  ),
  compact: Options.boolean("compact").pipe(
    Options.withDescription("Reduce JSON output verbosity for agent consumption")
  ),
  logFormat: Options.choice("log-format", ["json", "human"]).pipe(
    Options.optional,
    Options.withDescription("Override log format (json or human)")
  ),
  syncConcurrency: Options.integer("sync-concurrency").pipe(
    Options.optional,
    Options.withDescription("Concurrent sync preparation workers (default: 5)")
  ),
  syncBatchSize: Options.integer("sync-batch-size").pipe(
    Options.optional,
    Options.withDescription("Batch size for sync store writes (default: 100)")
  ),
  syncPageLimit: Options.integer("sync-page-limit").pipe(
    Options.optional,
    Options.withDescription("Page size for sync fetches (default: 100)")
  ),
  checkpointEvery: Options.integer("checkpoint-every").pipe(
    Options.optional,
    Options.withDescription("Checkpoint every N processed posts (default: 100)")
  ),
  checkpointIntervalMs: Options.integer("checkpoint-interval-ms").pipe(
    Options.optional,
    Options.withDescription("Checkpoint interval in milliseconds (default: 5000)")
  )
};

export type ConfigOptions = {
  readonly service: Option.Option<string>;
  readonly storeRoot: Option.Option<string>;
  readonly outputFormat: Option.Option<OutputFormat>;
  readonly identifier: Option.Option<string>;
  readonly password: Option.Option<Redacted.Redacted<string>>;
  readonly compact: boolean;
  readonly logFormat: Option.Option<LogFormat>;
  readonly syncConcurrency: Option.Option<number>;
  readonly syncBatchSize: Option.Option<number>;
  readonly syncPageLimit: Option.Option<number>;
  readonly checkpointEvery: Option.Option<number>;
  readonly checkpointIntervalMs: Option.Option<number>;
};

export const toConfigOverrides = (options: ConfigOptions): Partial<AppConfig> =>
  pickDefined({
    service: Option.getOrUndefined(options.service),
    storeRoot: Option.getOrUndefined(options.storeRoot),
    outputFormat: Option.getOrUndefined(options.outputFormat),
    identifier: Option.getOrUndefined(options.identifier)
  }) as Partial<AppConfig>;

export const toCredentialsOverrides = (
  options: ConfigOptions
): CredentialsOverridesValue =>
  pickDefined({
    identifier: Option.getOrUndefined(options.identifier),
    password: Option.getOrUndefined(options.password)
  }) as CredentialsOverridesValue;

export const toSyncSettingsOverrides = (
  options: ConfigOptions
): Partial<SyncSettingsValue> =>
  pickDefined({
    concurrency: Option.getOrUndefined(options.syncConcurrency),
    batchSize: Option.getOrUndefined(options.syncBatchSize),
    pageLimit: Option.getOrUndefined(options.syncPageLimit),
    checkpointEvery: Option.getOrUndefined(options.checkpointEvery),
    checkpointIntervalMs: Option.getOrUndefined(options.checkpointIntervalMs)
  }) as Partial<SyncSettingsValue>;

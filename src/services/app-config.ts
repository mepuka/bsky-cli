import { FileSystem } from "@effect/platform";
import { Path } from "@effect/platform";
import { Config, Effect, Option, Schema } from "effect";
import { formatSchemaError, pickDefined } from "./shared.js";
import { AppConfig, OutputFormat } from "../domain/config.js";
import { ConfigError } from "../domain/errors.js";

/**
 * Application Configuration Service
 *
 * This module provides centralized configuration management for the application.
 * It implements a layered configuration resolution strategy with support for
 * multiple configuration sources and home directory expansion.
 *
 * Configuration Resolution Priority (highest to lowest):
 * 1. Runtime overrides (ConfigOverrides service)
 * 2. Environment variables (SKYGENT_*)
 * 3. Config file (~/.skygent/config.json)
 * 4. Default values
 *
 * Key features:
 * - Home directory expansion (~ → $HOME)
 * - Path normalization (relative → absolute)
 * - Schema validation with detailed error messages
 * - Graceful handling of missing config files
 * - Type-safe configuration access via Effect Context
 *
 * Environment Variables:
 * - SKYGENT_SERVICE: Bluesky service URL (default: https://bsky.social)
 * - SKYGENT_STORE_ROOT: Root directory for store data (default: ~/.skygent)
 * - SKYGENT_OUTPUT_FORMAT: Output format (json, ndjson, markdown, table)
 * - SKYGENT_IDENTIFIER: User identifier for authentication
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { AppConfigService, ConfigOverrides } from "./services/app-config.js";
 *
 * // Basic usage - read configuration
 * const program = Effect.gen(function* () {
 *   const config = yield* AppConfigService;
 *   console.log(`Store root: ${config.storeRoot}`);
 *   console.log(`Service: ${config.service}`);
 * });
 *
 * // With runtime overrides
 * const withOverrides = program.pipe(
 *   Effect.provide(
 *     ConfigOverrides.layer({
 *       storeRoot: "/custom/path",
 *       outputFormat: "json"
 *     })
 *   )
 * );
 * ```
 *
 * @module services/app-config
 */

type AppConfigOverrides = Partial<AppConfig>;

/**
 * Service for providing runtime configuration overrides.
 *
 * Allows injection of configuration values at runtime that take precedence
 * over environment variables and config file settings. This is useful for
 * CLI arguments, test configuration, or dynamic configuration scenarios.
 *
 * @example
 * ```typescript
 * // Provide overrides via layer
 * const overridesLayer = ConfigOverrides.layer({
 *   storeRoot: "/tmp/test-store",
 *   outputFormat: "json"
 * });
 *
 * // Use in program
 * const program = Effect.gen(function* () {
 *   const config = yield* AppConfigService;
 *   // config.storeRoot will be "/tmp/test-store"
 * }).pipe(Effect.provide(overridesLayer));
 * ```
 */
export class ConfigOverrides extends Effect.Service<ConfigOverrides>()("@skygent/ConfigOverrides", {
  succeed: {} as AppConfigOverrides
}) {
  /**
   * Default empty configuration overrides layer.
   *
   * Use this as a base layer when no overrides are needed, or extend it
   * with custom overrides using Layer.succeed.
   */
  static readonly layer = ConfigOverrides.Default;
}

const PartialAppConfig = Schema.Struct({
  service: Schema.optional(Schema.String),
  storeRoot: Schema.optional(Schema.String),
  outputFormat: Schema.optional(OutputFormat),
  identifier: Schema.optional(Schema.String)
});

type PartialAppConfig = typeof PartialAppConfig.Type;

const defaultService = "https://bsky.social";
const defaultOutputFormat: OutputFormat = "ndjson";
const defaultRootDirName = ".skygent";
const configFileName = "config.json";



const resolveHomeDir = () =>
  process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH;

const expandHome = (path: Path.Path, value: string, home?: string) => {
  if (!home) return value;
  if (value === "~") return home;
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const resolveDefaultRoot = (path: Path.Path) => {
  const home = resolveHomeDir();
  return home ? path.join(home, defaultRootDirName) : path.resolve(defaultRootDirName);
};

const normalizeStoreRoot = (path: Path.Path, value: string) => {
  const home = resolveHomeDir();
  const expanded = expandHome(path, value, home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
};

const decodeConfigJson = (raw: string, configPath: string) =>
  Schema.decodeUnknown(Schema.parseJson(PartialAppConfig))(raw).pipe(
    Effect.mapError((error) =>
      ConfigError.make({
        message: `Invalid config JSON at ${configPath}: ${formatSchemaError(error)}`,
        path: configPath,
        cause: error
      })
    )
  );

const loadFileConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(configPath).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SystemError", (error) =>
        error.reason === "NotFound"
          ? Effect.succeed(Option.none())
          : Effect.fail(
              ConfigError.make({
                message: `Failed to read config at ${configPath}`,
                path: configPath,
                cause: error
              })
            )
      )
    );

    return yield* Option.match(content, {
      onNone: () => Effect.succeed({} as PartialAppConfig),
      onSome: (raw) => decodeConfigJson(raw, configPath)
    });
  });

const envOutputFormat = Config.literal("json", "ndjson", "markdown", "table")(
  "SKYGENT_OUTPUT_FORMAT"
);

/**
 * Service for accessing the resolved application configuration.
 *
 * Provides type-safe access to the fully resolved application configuration
 * with values from all sources (overrides, environment, config file, defaults)
 * merged according to the priority hierarchy.
 *
 * @example
 * ```typescript
 * // Access configuration in an Effect
 * const program = Effect.gen(function* () {
 *   const config = yield* AppConfigService;
 *
 *   // All configuration values are resolved and validated
 *   const { service, storeRoot, outputFormat, identifier } = config;
 *
 *   // Use configuration values
 *   console.log(`Using service: ${service}`);
 *   console.log(`Storing data in: ${storeRoot}`);
 * });
 *
 * // Provide the configuration layer
 * const runnable = program.pipe(Effect.provide(AppConfigService.layer));
 * ```
 */
export class AppConfigService extends Effect.Service<AppConfigService>()("@skygent/AppConfig", {
  effect: Effect.gen(function* () {
    const { _tag: _, ...overrides } = yield* ConfigOverrides;
    const path = yield* Path.Path;
    const defaultRoot = resolveDefaultRoot(path);
    const configPath = path.join(defaultRoot, configFileName);

    const fileConfig = yield* loadFileConfig(configPath);

    const envService = yield* Config.string("SKYGENT_SERVICE").pipe(Config.option);
    const envStoreRoot = yield* Config.string("SKYGENT_STORE_ROOT").pipe(Config.option);
    const envFormat = yield* envOutputFormat.pipe(Config.option);
    const envIdentifier = yield* Config.string("SKYGENT_IDENTIFIER").pipe(Config.option);

    const envConfig = pickDefined({
      service: Option.getOrUndefined(envService),
      storeRoot: Option.getOrUndefined(envStoreRoot),
      outputFormat: Option.getOrUndefined(envFormat),
      identifier: Option.getOrUndefined(envIdentifier)
    });

    const merged = {
      service: defaultService,
      storeRoot: defaultRoot,
      outputFormat: defaultOutputFormat,
      ...fileConfig,
      ...envConfig,
      ...pickDefined(overrides as Record<string, unknown>)
    };

    const resolvedStoreRoot = merged.storeRoot ?? defaultRoot;
    const normalized = {
      ...merged,
      storeRoot: normalizeStoreRoot(path, resolvedStoreRoot)
    };

    const decoded = yield* Schema.decodeUnknown(AppConfig)(normalized).pipe(
      Effect.mapError((error) =>
        ConfigError.make({
          message: `Invalid config: ${formatSchemaError(error)}`,
          path: configPath,
          cause: error
        })
      )
    );
    return decoded;
  })
}) {
  /**
   * Layer that constructs the AppConfigService by resolving configuration
   * from all sources in priority order.
   *
   * Resolution order (highest to lowest priority):
   * 1. ConfigOverrides service values
   * 2. Environment variables (SKYGENT_*)
   * 3. ~/.skygent/config.json file
   * 4. Default values
   *
   * @returns Layer providing the resolved AppConfigService
   * @throws ConfigError if configuration validation fails
   *
   * @example
   * ```typescript
   * // Basic usage with defaults
   * const program = Effect.provide(myProgram, AppConfigService.layer);
   *
   * // With custom overrides
   * const customLayer = Layer.merge(
   *   AppConfigService.layer,
   *   ConfigOverrides.layer({ outputFormat: "json" })
   * );
   * ```
   */
  static readonly layer = AppConfigService.Default;
}

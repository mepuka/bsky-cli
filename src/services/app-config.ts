import { FileSystem } from "@effect/platform";
import { Path } from "@effect/platform";
import { Config, Context, Effect, Layer, Option, ParseResult, Schema } from "effect";
import { AppConfig, OutputFormat } from "../domain/config.js";
import { ConfigError } from "../domain/errors.js";

type AppConfigOverrides = Partial<AppConfig>;

export class ConfigOverrides extends Context.Tag("@skygent/ConfigOverrides")<
  ConfigOverrides,
  AppConfigOverrides
>() {
  static readonly layer = Layer.succeed(ConfigOverrides, {});
}

const PartialAppConfig = Schema.Struct({
  service: Schema.optional(Schema.String),
  storeRoot: Schema.optional(Schema.String),
  outputFormat: Schema.optional(OutputFormat),
  identifier: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String)
});

type PartialAppConfig = typeof PartialAppConfig.Type;

const defaultService = "https://bsky.social";
const defaultOutputFormat: OutputFormat = "ndjson";
const defaultRootDirName = ".skygent";
const configFileName = "config.json";

const pickDefined = <T extends Record<string, unknown>>(input: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as Partial<T>;

const formatSchemaError = (error: unknown) => {
  if (ParseResult.isParseError(error)) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }
  return String(error);
};

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

export class AppConfigService extends Context.Tag("@skygent/AppConfig")<
  AppConfigService,
  AppConfig
>() {
  static readonly layer = Layer.effect(
    AppConfigService,
    Effect.gen(function* () {
      const overrides = yield* ConfigOverrides;
      const path = yield* Path.Path;
      const defaultRoot = resolveDefaultRoot(path);
      const configPath = path.join(defaultRoot, configFileName);

      const fileConfig = yield* loadFileConfig(configPath);

      const envService = yield* Config.string("SKYGENT_SERVICE").pipe(Config.option);
      const envStoreRoot = yield* Config.string("SKYGENT_STORE_ROOT").pipe(Config.option);
      const envFormat = yield* envOutputFormat.pipe(Config.option);
      const envIdentifier = yield* Config.string("SKYGENT_IDENTIFIER").pipe(Config.option);
      const envPassword = yield* Config.string("SKYGENT_PASSWORD").pipe(Config.option);

      const envConfig = pickDefined({
        service: Option.getOrUndefined(envService),
        storeRoot: Option.getOrUndefined(envStoreRoot),
        outputFormat: Option.getOrUndefined(envFormat),
        identifier: Option.getOrUndefined(envIdentifier),
        password: Option.getOrUndefined(envPassword)
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
      return AppConfigService.of(decoded);
    })
  );
}

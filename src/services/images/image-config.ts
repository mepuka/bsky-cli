import { Path } from "@effect/platform";
import { Config, Duration, Effect, Option } from "effect";
import { AppConfigService } from "../app-config.js";
import { validateNonNegative } from "../shared.js";

export type ImageConfigValue = {
  readonly enabled: boolean;
  readonly cacheRoot: string;
  readonly metaRoot: string;
  readonly originalsRoot: string;
  readonly thumbsRoot: string;
  readonly cacheTtl: Duration.Duration;
  readonly failureTtl: Duration.Duration;
  readonly memCapacity: number;
  readonly memTtl: Duration.Duration;
};

const resolveCacheRoot = (
  path: Path.Path,
  storeRoot: string,
  override: string | undefined
) => {
  if (!override || override.trim().length === 0) {
    return path.join(storeRoot, ".image-cache");
  }
  return path.isAbsolute(override)
    ? override
    : path.join(storeRoot, override);
};

export class ImageConfig extends Effect.Service<ImageConfig>()("@skygent/ImageConfig", {
  effect: Effect.gen(function* () {
    const appConfig = yield* AppConfigService;
    const path = yield* Path.Path;

    const enabled = yield* Config.boolean("SKYGENT_IMAGE_CACHE_ENABLED").pipe(
      Config.withDefault(false)
    );
    const cacheRootOverride = yield* Config.string(
      "SKYGENT_IMAGE_CACHE_ROOT"
    ).pipe(Config.option);
    const cacheRoot = resolveCacheRoot(
      path,
      appConfig.storeRoot,
      Option.getOrUndefined(cacheRootOverride)
    );

    const cacheTtl = yield* Config.duration("SKYGENT_IMAGE_CACHE_TTL").pipe(
      Config.withDefault(Duration.days(7))
    );
    const failureTtl = yield* Config.duration(
      "SKYGENT_IMAGE_CACHE_FAILURE_TTL"
    ).pipe(Config.withDefault(Duration.hours(1)));
    const memCapacity = yield* Config.integer(
      "SKYGENT_IMAGE_CACHE_MEM_CAPACITY"
    ).pipe(Config.withDefault(1024));
    const memTtl = yield* Config.duration("SKYGENT_IMAGE_CACHE_MEM_TTL").pipe(
      Config.withDefault(Duration.minutes(5))
    );

    const cacheTtlError = validateNonNegative(
      "SKYGENT_IMAGE_CACHE_TTL",
      Duration.toMillis(cacheTtl)
    );
    if (cacheTtlError) {
      return yield* cacheTtlError;
    }
    const failureTtlError = validateNonNegative(
      "SKYGENT_IMAGE_CACHE_FAILURE_TTL",
      Duration.toMillis(failureTtl)
    );
    if (failureTtlError) {
      return yield* failureTtlError;
    }
    const memCapacityError = validateNonNegative(
      "SKYGENT_IMAGE_CACHE_MEM_CAPACITY",
      memCapacity
    );
    if (memCapacityError) {
      return yield* memCapacityError;
    }
    const memTtlError = validateNonNegative(
      "SKYGENT_IMAGE_CACHE_MEM_TTL",
      Duration.toMillis(memTtl)
    );
    if (memTtlError) {
      return yield* memTtlError;
    }

    return {
      enabled,
      cacheRoot,
      metaRoot: path.join(cacheRoot, "meta"),
      originalsRoot: path.join(cacheRoot, "original"),
      thumbsRoot: path.join(cacheRoot, "thumb"),
      cacheTtl,
      failureTtl,
      memCapacity,
      memTtl
    };
  })
}) {
  static readonly layer = ImageConfig.Default;
}

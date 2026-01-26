import { FileSystem, Path } from "@effect/platform";
import { Clock, Config, Context, Duration, Effect, Layer, Ref } from "effect";
import { AppConfigService } from "./app-config.js";

export type ResourceWarning =
  | {
      readonly _tag: "StoreSize";
      readonly bytes: number;
      readonly threshold: number;
      readonly root: string;
    }
  | {
      readonly _tag: "MemoryRss";
      readonly bytes: number;
      readonly threshold: number;
    };

export interface ResourceMonitorService {
  readonly check: () => Effect.Effect<ReadonlyArray<ResourceWarning>>;
}

export class ResourceMonitor extends Context.Tag("@skygent/ResourceMonitor")<
  ResourceMonitor,
  ResourceMonitorService
>() {
  static readonly layer = Layer.effect(
    ResourceMonitor,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const interval = yield* Config.duration("SKYGENT_RESOURCE_CHECK_INTERVAL").pipe(
        Config.withDefault(Duration.minutes(1))
      );
      const storeWarnBytes = yield* Config.integer(
        "SKYGENT_RESOURCE_STORE_WARN_BYTES"
      ).pipe(Config.withDefault(1_073_741_824));
      const rssWarnBytes = yield* Config.integer(
        "SKYGENT_RESOURCE_RSS_WARN_BYTES"
      ).pipe(Config.withDefault(1_073_741_824));

      const lastCheck = yield* Ref.make(0);
      const intervalMs = Duration.toMillis(interval);

      const directorySize = (root: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
          if (!exists) {
            return 0;
          }
          const entries = yield* fs
            .readDirectory(root, { recursive: true })
            .pipe(Effect.orElseSucceed(() => []));
          if (entries.length === 0) {
            return 0;
          }
          const sizes = yield* Effect.forEach(
            entries,
            (entry) =>
              fs
                .stat(path.join(root, entry))
                .pipe(
                  Effect.map((info) =>
                    info.type === "File" ? Number(info.size) : 0
                  ),
                  Effect.orElseSucceed(() => 0)
                ),
            { concurrency: 10 }
          );
          return sizes.reduce((total, size) => total + size, 0);
        });

      const rssUsage = () => {
        if (
          typeof process !== "undefined" &&
          typeof process.memoryUsage === "function"
        ) {
          return process.memoryUsage().rss;
        }
        return 0;
      };

      const check = Effect.fn("ResourceMonitor.check")(() =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const last = yield* Ref.get(lastCheck);
          if (now - last < intervalMs) {
            return [] as ReadonlyArray<ResourceWarning>;
          }
          yield* Ref.set(lastCheck, now);

          const warnings: Array<ResourceWarning> = [];

          if (storeWarnBytes > 0) {
            const total = yield* directorySize(config.storeRoot);
            if (total >= storeWarnBytes) {
              warnings.push({
                _tag: "StoreSize",
                bytes: total,
                threshold: storeWarnBytes,
                root: config.storeRoot
              });
            }
          }

          if (rssWarnBytes > 0) {
            const rss = rssUsage();
            if (rss >= rssWarnBytes) {
              warnings.push({
                _tag: "MemoryRss",
                bytes: rss,
                threshold: rssWarnBytes
              });
            }
          }

          return warnings;
        }).pipe(Effect.orElseSucceed(() => []))
      );

      return ResourceMonitor.of({ check });
    })
  );

  static readonly testLayer = Layer.succeed(
    ResourceMonitor,
    ResourceMonitor.of({
      check: () => Effect.succeed([])
    })
  );
}

import { Command } from "@effect/cli";
import { Layer } from "effect";
import { CliLive } from "./layers.js";
import { ConfigOverrides } from "../services/app-config.js";
import { CredentialsOverrides } from "../services/credential-store.js";
import { CliPreferences } from "./preferences.js";
import { storeCommand } from "./store.js";
import { syncCommand } from "./sync.js";
import { queryCommand } from "./query.js";
import { watchCommand } from "./watch.js";
import { deriveCommand } from "./derive.js";
import { viewCommand } from "./view.js";
import { filterCommand } from "./filter.js";
import { configOptions, toConfigOverrides, toCredentialsOverrides } from "./config.js";

export const app = Command.make("skygent", configOptions).pipe(
  Command.withSubcommands([
    storeCommand,
    syncCommand,
    queryCommand,
    watchCommand,
    deriveCommand,
    viewCommand,
    filterCommand
  ]),
  Command.provide((config) =>
    Layer.mergeAll(
      CliLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigOverrides, toConfigOverrides(config)),
            Layer.succeed(CredentialsOverrides, toCredentialsOverrides(config))
          )
        )
      ),
      Layer.succeed(CliPreferences, { compact: config.compact })
    )
  ),
  Command.withDescription("Skygent CLI for Bluesky monitoring")
);

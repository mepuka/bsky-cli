import { Command } from "@effect/cli";
import { Layer } from "effect";
import { CliLive } from "./layers.js";
import { ConfigOverrides } from "../services/app-config.js";
import { CredentialsOverrides } from "../services/credential-store.js";
import { storeCommand } from "./store.js";
import { syncCommand } from "./sync.js";
import { queryCommand } from "./query.js";
import { watchCommand } from "./watch.js";
import { deriveCommand } from "./derive.js";
import { viewCommand } from "./view.js";
import { configOptions, toConfigOverrides, toCredentialsOverrides } from "./config.js";

export const app = Command.make("skygent", configOptions).pipe(
  Command.withSubcommands([storeCommand, syncCommand, queryCommand, watchCommand, deriveCommand, viewCommand]),
  Command.provide((config) =>
    CliLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ConfigOverrides, toConfigOverrides(config)),
          Layer.succeed(CredentialsOverrides, toCredentialsOverrides(config))
        )
      )
    )
  ),
  Command.withDescription("Skygent CLI for Bluesky monitoring")
);

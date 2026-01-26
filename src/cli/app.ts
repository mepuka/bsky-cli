import { Command } from "@effect/cli";
import { Layer } from "effect";
import { CliLive } from "./layers.js";
import { ConfigOverrides } from "../services/app-config.js";
import { storeCommand } from "./store.js";
import { syncCommand } from "./sync.js";
import { queryCommand } from "./query.js";
import { watchCommand } from "./watch.js";
import { configOptions, toConfigOverrides } from "./config.js";

export const app = Command.make("skygent", configOptions).pipe(
  Command.withSubcommands([storeCommand, syncCommand, queryCommand, watchCommand]),
  Command.provide((config) =>
    CliLive.pipe(
      Layer.provide(
        Layer.succeed(ConfigOverrides, toConfigOverrides(config))
      )
    )
  ),
  Command.withDescription("Skygent CLI for Bluesky monitoring")
);

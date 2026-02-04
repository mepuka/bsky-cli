import { Command } from "@effect/cli";
import { Layer, Option } from "effect";
import { CliLive } from "./layers.js";
import { ConfigOverrides } from "../services/app-config.js";
import { CredentialsOverrides } from "../services/credential-store.js";
import { DerivationSettingsOverrides } from "../services/derivation-settings.js";
import { SyncSettingsOverrides } from "../services/sync-settings.js";
import { CliPreferences } from "./preferences.js";
import { storeCommand } from "./store.js";
import { syncCommand } from "./sync.js";
import { queryCommand } from "./query.js";
import { watchCommand } from "./watch.js";
import { deriveCommand } from "./derive.js";
import { viewCommand } from "./view.js";
import { filterCommand } from "./filter.js";
import { searchCommand } from "./search.js";
import { graphCommand } from "./graph.js";
import { feedCommand } from "./feed.js";
import { postCommand } from "./post.js";
import { pipeCommand } from "./pipe.js";
import { imageCacheCommand } from "./image-cache-command.js";
import { configCommand } from "./config-command.js";
import { digestCommand } from "./digest.js";
import { actorCommand } from "./actor.js";
import { capabilitiesCommand } from "./capabilities.js";
import {
  configOptions,
  toConfigOverrides,
  toCredentialsOverrides,
  toSyncSettingsOverrides
} from "./config.js";
import { withExamples } from "./help.js";

export const app = Command.make("skygent", configOptions).pipe(
  Command.withSubcommands([
    configCommand,
    storeCommand,
    syncCommand,
    queryCommand,
    watchCommand,
    deriveCommand,
    viewCommand,
    filterCommand,
    searchCommand,
    graphCommand,
    feedCommand,
    postCommand,
    imageCacheCommand,
    pipeCommand,
    digestCommand,
    actorCommand,
    capabilitiesCommand
  ]),
  Command.provide((config) =>
    Layer.mergeAll(
      CliLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ConfigOverrides, toConfigOverrides(config)),
            Layer.succeed(CredentialsOverrides, toCredentialsOverrides(config)),
            Layer.succeed(SyncSettingsOverrides, toSyncSettingsOverrides(config)),
            DerivationSettingsOverrides.layer
          )
        )
      ),
      Layer.succeed(
        CliPreferences,
        Option.match(config.logFormat, {
          onNone: () => ({ compact: config.compact }),
          onSome: (logFormat) => ({ compact: config.compact, logFormat })
        })
      )
    )
  ),
  Command.withDescription(
    withExamples(
      "Skygent CLI for Bluesky monitoring",
      [
        "skygent store list --compact",
        "skygent sync timeline --store my-store --quiet"
      ],
      ["Tip: compact output is the default; use --full for verbose JSON."]
    )
  )
);

import { Command, Options } from "@effect/cli";
import { Effect } from "effect";
import { cacheTtlSweep } from "./image-cache.js";
import { writeJson } from "./output.js";
import { withExamples } from "./help.js";

const sweepForceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Delete expired cache files (default: dry-run)")
);
const sweepThumbnailsOption = Options.boolean("thumbnails").pipe(
  Options.withDescription("Include thumbnails when sweeping expired cache files")
);

const sweepCommand = Command.make(
  "sweep",
  { thumbnails: sweepThumbnailsOption, force: sweepForceOption },
  ({ thumbnails, force }) =>
    Effect.gen(function* () {
      const result = yield* cacheTtlSweep({
        includeThumbnails: thumbnails,
        remove: force
      });
      yield* writeJson(result);
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sweep expired image cache files (TTL-based)",
      [
        "skygent image-cache sweep",
        "skygent image-cache sweep --thumbnails --force"
      ],
      ["Tip: omit --force to run a dry sweep first."]
    )
  )
);

export const imageCacheCommand = Command.make("image-cache", {}).pipe(
  Command.withSubcommands([sweepCommand]),
  Command.withDescription(
    withExamples("Manage the image cache", [
      "skygent image-cache sweep"
    ])
  )
);

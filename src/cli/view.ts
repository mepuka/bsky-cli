import { Args, Command } from "@effect/cli";
import { Effect } from "effect";
import { StoreName } from "../domain/primitives.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { writeJson } from "./output.js";
import { withExamples } from "./help.js";
import { threadCommand } from "./view-thread.js";

const viewArg = Args.text({ name: "view" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Derived view store name")
);
const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Source store name")
);

const statusCommand = Command.make(
  "status",
  { view: viewArg, source: sourceArg },
  ({ view, source }) =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const isStale = yield* validator.isStale(view, source);

      yield* writeJson({
        view,
        source,
        status: isStale ? "stale" : "ready"
      });
    })
).pipe(
  Command.withDescription(
    withExamples("Check if a derived view is stale relative to its source", [
      "skygent view status derived-store source-store"
    ])
  )
);

export const viewCommand = Command.make("view", {}).pipe(
  Command.withSubcommands([statusCommand, threadCommand]),
  Command.withDescription(
    withExamples("View derivation status and metadata", [
      "skygent view status derived-store source-store"
    ])
  )
);

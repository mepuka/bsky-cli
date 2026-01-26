import { Args, Command } from "@effect/cli";
import { Effect } from "effect";
import { StoreName } from "../domain/primitives.js";
import { DerivationValidator } from "../services/derivation-validator.js";
import { writeJson } from "./output.js";

const viewArg = Args.text({ name: "view" }).pipe(Args.withSchema(StoreName));
const sourceArg = Args.text({ name: "source" }).pipe(Args.withSchema(StoreName));

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
).pipe(Command.withDescription("Check if a derived view is stale relative to its source"));

export const viewCommand = Command.make("view", {}).pipe(
  Command.withSubcommands([statusCommand]),
  Command.withDescription("View derivation status and metadata")
);

import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { FilterExprSchema, all, filterExprSignature, isEffectfulFilter } from "../domain/filter.js";
import { StoreName } from "../domain/primitives.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { decodeJson } from "./parse.js";
import { writeJson } from "./output.js";
import { storeOptions } from "./store.js";
import { CliInputError } from "./errors.js";
import type { FilterEvaluationMode } from "../domain/derivation.js";

const sourceArg = Args.text({ name: "source" }).pipe(Args.withSchema(StoreName));
const targetArg = Args.text({ name: "target" }).pipe(Args.withSchema(StoreName));

const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription("Filter expression as JSON string"),
  Options.optional
);

const modeOption = Options.choice("mode", ["event-time", "derive-time"]).pipe(
  Options.withDescription("Filter evaluation mode"),
  Options.withDefault("event-time" as const)
);

const resetFlag = Options.boolean("reset").pipe(
  Options.withDescription("Reset the target store before deriving")
);

const yesFlag = Options.boolean("yes").pipe(
  Options.withAlias("y"),
  Options.withDescription("Confirm destructive operations")
);

const parseFilter = (filterJson: Option.Option<string>) =>
  Option.match(filterJson, {
    onNone: () => Effect.succeed(all()),
    onSome: (raw) => decodeJson(FilterExprSchema, raw)
  });

const mapMode = (mode: "event-time" | "derive-time"): FilterEvaluationMode => {
  return mode === "event-time" ? "EventTime" : "DeriveTime";
};

export const deriveCommand = Command.make(
  "derive",
  { source: sourceArg, target: targetArg, filter: filterJsonOption, mode: modeOption, reset: resetFlag, yes: yesFlag },
  ({ source, target, filter, mode, reset, yes }) =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const checkpoints = yield* ViewCheckpointStore;

      // Parse filter expression
      const filterExpr = yield* parseFilter(filter);

      // Validation 1: EventTime mode guard for effectful filters
      // Defense-in-depth: CLI validates for UX (user-friendly errors),
      // service validates for safety (in case called from other contexts)
      const evaluationMode = mapMode(mode);
      if (evaluationMode === "EventTime" && isEffectfulFilter(filterExpr)) {
        return yield* CliInputError.make({
          message:
            "EventTime mode does not allow Llm/Trending/HasValidLinks filters. Use --mode derive-time for effectful filters.",
          cause: { filterExpr, mode: evaluationMode }
        });
      }

      // Validation 2: Reset requires --yes confirmation
      if (reset && !yes) {
        return yield* CliInputError.make({
          message: "--reset is destructive. Re-run with --yes to confirm.",
          cause: { reset: true, yes: false }
        });
      }

      // Validation 3: Filter change detection (only if not resetting)
      if (!reset) {
        const checkpointOption = yield* checkpoints.load(target, source);
        if (Option.isSome(checkpointOption)) {
          const checkpoint = checkpointOption.value;
          const newFilterHash = filterExprSignature(filterExpr);
          if (checkpoint.filterHash !== newFilterHash) {
            const message = [
              "Filter expression has changed since last derivation.",
              `Previous filter hash: ${checkpoint.filterHash}`,
              `New filter hash:      ${newFilterHash}`,
              "",
              "This would result in inconsistent data. Options:",
              "  1. Use --reset --yes to discard existing data and start fresh",
              "  2. Use the same filter expression as before",
              "  3. Derive into a new target store"
            ].join("\n");

            return yield* CliInputError.make({
              message,
              cause: {
                oldHash: checkpoint.filterHash,
                newHash: newFilterHash
              }
            });
          }
        }
      }

      // Load store references
      const sourceRef = yield* storeOptions.loadStoreRef(source);
      const targetRef = yield* storeOptions.loadStoreRef(target);

      // Execute derivation
      const result = yield* engine.derive(sourceRef, targetRef, filterExpr, {
        mode: evaluationMode,
        reset
      });

      // Output result with context
      yield* writeJson({
        source: sourceRef.name,
        target: targetRef.name,
        mode: evaluationMode,
        result
      });
    })
).pipe(
  Command.withDescription(
    "Derive a target store from a source store by applying a filter"
  )
);

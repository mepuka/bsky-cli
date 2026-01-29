import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { filterExprSignature, isEffectfulFilter } from "../domain/filter.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { StoreName } from "../domain/primitives.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { StoreManager } from "../services/store-manager.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { OutputManager } from "../services/output-manager.js";
import { StoreLock } from "../services/store-lock.js";
import { filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { writeJson } from "./output.js";
import { storeOptions } from "./store.js";
import { CliInputError } from "./errors.js";
import { StoreLockError } from "../domain/errors.js";
import { logInfo } from "./logging.js";
import type { FilterEvaluationMode } from "../domain/derivation.js";
import { CliPreferences } from "./preferences.js";
import { withExamples } from "./help.js";
import { filterOption, waitOption } from "./shared-options.js";
import { parseOptionalDuration } from "./interval.js";

const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Source store name")
);
const targetArg = Args.text({ name: "target" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Target (derived) store name")
);

const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(
    filterJsonDescription("EventTime mode supports pure filters only.")
  ),
  Options.optional
);

const modeOption = Options.choice("mode", ["event-time", "derive-time"]).pipe(
  Options.withDescription("Filter evaluation mode (default: event-time)"),
  Options.withDefault("event-time" as const)
);

const resetFlag = Options.boolean("reset").pipe(
  Options.withDescription("Reset the target store before deriving")
);

const yesFlag = Options.boolean("yes").pipe(
  Options.withAlias("y"),
  Options.withDescription("Confirm destructive operations")
);

const mapMode = (mode: "event-time" | "derive-time"): FilterEvaluationMode => {
  return mode === "event-time" ? "EventTime" : "DeriveTime";
};

export const deriveCommand = Command.make(
  "derive",
  {
    source: sourceArg,
    target: targetArg,
    filter: filterOption,
    filterJson: filterJsonOption,
    mode: modeOption,
    reset: resetFlag,
    yes: yesFlag,
    wait: waitOption
  },
  ({ source, target, filter, filterJson, mode, reset, yes, wait }) =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const outputManager = yield* OutputManager;
      const storeLock = yield* StoreLock;
      const preferences = yield* CliPreferences;
      const parsedWait = yield* parseOptionalDuration(wait);
      const waitFor = Option.getOrUndefined(parsedWait);

      // Parse filter expression
      const filterExpr = yield* parseFilterExpr(filter, filterJson);

      // Validation 1: EventTime mode guard for effectful filters
      // Defense-in-depth: CLI validates for UX (user-friendly errors),
      // service validates for safety (in case called from other contexts)
      const evaluationMode = mapMode(mode);
      if (evaluationMode === "EventTime" && isEffectfulFilter(filterExpr)) {
        return yield* CliInputError.make({
          message:
            "EventTime mode does not allow Trending/HasValidLinks filters. Use --mode derive-time for effectful filters.",
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

      // Validation 3: Source and target must be different
      if (source === target) {
        return yield* CliInputError.make({
          message: "Source and target stores must be different.",
          cause: { source, target }
        });
      }

      // Validation 4: Filter or mode change detection (only if not resetting)
      if (!reset) {
        const checkpointOption = yield* checkpoints.load(target, source);
        if (Option.isSome(checkpointOption)) {
          const checkpoint = checkpointOption.value;
          const newFilterHash = filterExprSignature(filterExpr);
          if (checkpoint.filterHash !== newFilterHash || checkpoint.evaluationMode !== evaluationMode) {
            const message = [
              "Derivation settings have changed since last derivation.",
              `Previous filter hash: ${checkpoint.filterHash}`,
              `New filter hash:      ${newFilterHash}`,
              `Previous mode:        ${checkpoint.evaluationMode}`,
              `New mode:             ${evaluationMode}`,
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
                newHash: newFilterHash,
                oldMode: checkpoint.evaluationMode,
                newMode: evaluationMode
              }
            });
          }
        }
      }

      // Load store references
      const sourceRef = yield* storeOptions.loadStoreRef(source);
      const targetOption = yield* manager.getStore(target);
      const targetRef = yield* Option.match(targetOption, {
        onNone: () =>
          manager.createStore(target, defaultStoreConfig).pipe(
            Effect.tap(() => logInfo("Auto-created target store", { target }))
          ),
        onSome: Effect.succeed
      });

      const storesToLock = [sourceRef, targetRef]
        .filter(
          (store, index, stores) =>
            stores.findIndex((value) => value.name === store.name) === index
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      const withStoreLocks = <A, E, R>(
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | StoreLockError, R> => {
        let next: Effect.Effect<A, E | StoreLockError, R> = effect;
        for (let i = storesToLock.length - 1; i >= 0; i -= 1) {
          const store = storesToLock[i];
          if (!store) {
            continue;
          }
          next = storeLock.withStoreLock(store, next, waitFor ? { waitFor } : undefined);
        }
        return next;
      };

      return yield* withStoreLocks(
        Effect.gen(function* () {
          // Execute derivation
          const result = yield* engine.derive(sourceRef, targetRef, filterExpr, {
            mode: evaluationMode,
            reset
          });

          const materialized = yield* outputManager.materializeStore(targetRef);
          if (materialized.filters.length > 0) {
            yield* logInfo("Materialized filter outputs", {
              store: targetRef.name,
              filters: materialized.filters.map((spec) => spec.name)
            });
          }

          // Output result with context
          if (preferences.compact) {
            yield* writeJson({
              source: sourceRef.name,
              target: targetRef.name,
              mode: evaluationMode,
              ...result
            });
            return;
          }

          yield* writeJson({
            source: sourceRef.name,
            target: targetRef.name,
            mode: evaluationMode,
            result
          });
        })
      );
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Derive a target store from a source store by applying a filter",
      [
        "skygent derive source-store derived-store --filter 'hashtag:#ai'",
        "skygent derive source-store derived-store --filter 'hashtag:#ai' --mode derive-time"
      ],
      ["Tip: use --reset --yes if you need to rebuild with a new filter or mode."]
    )
  )
);

import { Args, Command, Options } from "@effect/cli";
import { Clock, Effect, Option } from "effect";
import { FilterExprSemigroup, filterExprSignature, isEffectfulFilter, not } from "../domain/filter.js";
import { defaultStoreConfig } from "../domain/defaults.js";
import { Handle, StoreName } from "../domain/primitives.js";
import { DerivationEngine } from "../services/derivation-engine.js";
import { StoreManager } from "../services/store-manager.js";
import { IdentityResolver } from "../services/identity-resolver.js";
import { ViewCheckpointStore } from "../services/view-checkpoint-store.js";
import { OutputManager } from "../services/output-manager.js";
import { filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { writeJson } from "./output.js";
import { storeOptions } from "./store.js";
import { CliInputError } from "./errors.js";
import { logInfo } from "./logging.js";
import type { FilterEvaluationMode } from "../domain/derivation.js";
import { CliPreferences } from "./preferences.js";
import { withExamples } from "./help.js";
import { filterOption } from "./shared-options.js";

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

const includeAuthorOption = Options.text("include-author").pipe(
  Options.withDescription("Comma-separated handles or DIDs to include"),
  Options.optional
);

const excludeAuthorOption = Options.text("exclude-author").pipe(
  Options.withDescription("Comma-separated handles or DIDs to exclude"),
  Options.optional
);

const parseCsv = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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
    includeAuthor: includeAuthorOption,
    excludeAuthor: excludeAuthorOption,
    mode: modeOption,
    reset: resetFlag,
    yes: yesFlag
  },
  ({ source, target, filter, filterJson, includeAuthor, excludeAuthor, mode, reset, yes }) =>
    Effect.gen(function* () {
      const startTime = yield* Clock.currentTimeMillis;
      const engine = yield* DerivationEngine;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const outputManager = yield* OutputManager;
      const preferences = yield* CliPreferences;
      const identities = yield* IdentityResolver;

      // Parse filter expression
      const baseFilterExpr = yield* parseFilterExpr(filter, filterJson);

      const resolveAuthors = (value: Option.Option<string>) =>
        Option.match(value, {
          onNone: () => Effect.succeed([] as ReadonlyArray<Handle>),
          onSome: (raw) =>
            Effect.forEach(
              parseCsv(raw),
              (actor) =>
                identities.resolveIdentity(actor).pipe(
                  Effect.map((info) => info.handle),
                  Effect.mapError((error) =>
                    CliInputError.make({
                      message: `Failed to resolve author: ${error.message}`,
                      cause: error
                    })
                  )
                ),
              { concurrency: "unbounded" }
            ).pipe(
              Effect.map((handles) => Array.from(new Set(handles)))
            )
        });

      const includeAuthors = yield* resolveAuthors(includeAuthor);
      const excludeAuthors = yield* resolveAuthors(excludeAuthor);

      let filterExpr = baseFilterExpr;
      if (includeAuthors.length > 0) {
        filterExpr = FilterExprSemigroup.combine(filterExpr, {
          _tag: "AuthorIn",
          handles: includeAuthors
        });
      }
      if (excludeAuthors.length > 0) {
        filterExpr = FilterExprSemigroup.combine(
          filterExpr,
          not({
            _tag: "AuthorIn",
            handles: excludeAuthors
          })
        );
      }

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

      // Calculate duration and percentage
      const endTime = yield* Clock.currentTimeMillis;
      const duration = (endTime - startTime) / 1000;
      const percentage = result.eventsProcessed > 0 
        ? ((result.eventsMatched / result.eventsProcessed) * 100).toFixed(1)
        : "0.0";
      
      // Human-friendly summary (always shown)
      yield* logInfo(
        `Derived ${result.eventsMatched} posts (${percentage}%) from ${sourceRef.name} → ${targetRef.name} in ${duration.toFixed(1)}s`
      );

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
).pipe(
  Command.withDescription(
    withExamples(
      "Derive a target store from a source store by applying a filter",
      [
        "skygent derive source-store derived-store --filter 'hashtag:#ai'",
        "skygent derive source-store derived-store --filter 'hashtag:#ai' --mode derive-time",
        "skygent derive source-store derived-store --include-author alice.bsky.social,bob.bsky.social",
        "skygent derive source-store derived-store --exclude-author bot.bsky.social"
      ],
      ["Tip: use --reset --yes if you need to rebuild with a new filter or mode."]
    )
  )
);

import { Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { StoreName } from "../domain/primitives.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { CliInputError } from "./errors.js";

/** --store option with StoreName schema validation */
export const storeNameOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to write into")
);

/** --filter DSL option (optional) */
export const filterOption = Options.text("filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);

/** --filter-json option (optional) */
export const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
  Options.optional
);

/** --quiet flag to suppress progress output */
export const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);

/** --strict flag to stop on first error */
export const strictOption = Options.boolean("strict").pipe(
  Options.withDescription("Stop on first error and do not advance the checkpoint")
);

/** --max-errors option (optional) */
export const maxErrorsOption = Options.integer("max-errors").pipe(
  Options.withDescription("Stop after exceeding N errors (default: unlimited)"),
  Options.optional
);

/** Validate --max-errors value is non-negative */
export const parseMaxErrors = (maxErrors: Option.Option<number>) =>
  Option.match(maxErrors, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (value) =>
      value < 0
        ? Effect.fail(
            CliInputError.make({
              message: "max-errors must be a non-negative integer.",
              cause: value
            })
          )
        : Effect.succeed(Option.some(value))
  });

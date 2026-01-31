import { Effect, Option } from "effect";
import type { Clock as ClockService } from "effect/Clock";
import { FilterExprSchema, all } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import type { FilterLibrary } from "../services/filter-library.js";
import { CliInputError, CliJsonError } from "./errors.js";
import { decodeJson } from "./parse.js";
import { formatFilterParseError } from "./filter-errors.js";
import { parseFilterDsl } from "./filter-dsl.js";

const conflictError = (filter: boolean, filterJson: boolean) =>
  CliInputError.make({
    message: "Use only one of --filter or --filter-json.",
    cause: { filter, filterJson }
  });

export const parseFilterExpr = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
): Effect.Effect<FilterExpr, CliInputError | CliJsonError, FilterLibrary | ClockService> =>
  Option.match(filter, {
    onNone: () =>
      Option.match(filterJson, {
        onNone: () => Effect.succeed(all()),
        onSome: (raw) =>
          decodeJson(FilterExprSchema, raw, {
            formatter: formatFilterParseError
          })
      }),
    onSome: (raw) =>
      Option.match(filterJson, {
        onNone: () => parseFilterDsl(raw),
        onSome: () => Effect.fail(conflictError(true, true))
      })
  });

export const parseOptionalFilterExpr = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
): Effect.Effect<Option.Option<FilterExpr>, CliInputError | CliJsonError, FilterLibrary | ClockService> =>
  Option.match(filter, {
    onNone: () =>
      Option.match(filterJson, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (raw) =>
          decodeJson(FilterExprSchema, raw, {
            formatter: formatFilterParseError
          }).pipe(Effect.map(Option.some))
      }),
    onSome: (raw) =>
      Option.match(filterJson, {
        onNone: () => parseFilterDsl(raw).pipe(Effect.map(Option.some)),
        onSome: () => Effect.fail(conflictError(true, true))
      })
  });

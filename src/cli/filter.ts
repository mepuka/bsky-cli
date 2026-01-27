import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { StoreName } from "../domain/primitives.js";
import { FilterLibrary } from "../services/filter-library.js";
import { parseFilterExpr } from "./filter-input.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { writeJson } from "./output.js";
import { CliInputError } from "./errors.js";

const filterNameArg = Args.text({ name: "name" }).pipe(Args.withSchema(StoreName));

const filterOption = Options.text("filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);
const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
  Options.optional
);

const requireFilterExpr = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) =>
  Option.match(filter, {
    onNone: () =>
      Option.match(filterJson, {
        onNone: () =>
          Effect.fail(
            CliInputError.make({
              message: "Provide --filter or --filter-json.",
              cause: { filter: null, filterJson: null }
            })
          ),
        onSome: () => Effect.void
      }),
    onSome: () => Effect.void
  });

export const filterList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const library = yield* FilterLibrary;
    const names = yield* library.list();
    yield* writeJson(names);
  })
).pipe(Command.withDescription("List saved filters"));

export const filterShow = Command.make(
  "show",
  { name: filterNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const library = yield* FilterLibrary;
      const expr = yield* library.get(name);
      yield* writeJson(expr);
    })
).pipe(Command.withDescription("Show a saved filter"));

export const filterCreate = Command.make(
  "create",
  { name: filterNameArg, filter: filterOption, filterJson: filterJsonOption },
  ({ name, filter, filterJson }) =>
    Effect.gen(function* () {
      yield* requireFilterExpr(filter, filterJson);
      const expr = yield* parseFilterExpr(filter, filterJson);
      const library = yield* FilterLibrary;
      yield* library.save(name, expr);
      yield* writeJson({ name, saved: true });
    })
).pipe(Command.withDescription("Create or update a saved filter"));

export const filterDelete = Command.make(
  "delete",
  { name: filterNameArg },
  ({ name }) =>
    Effect.gen(function* () {
      const library = yield* FilterLibrary;
      yield* library.remove(name);
      yield* writeJson({ name, deleted: true });
    })
).pipe(Command.withDescription("Delete a saved filter"));

export const filterValidateAll = Command.make("validate-all", {}, () =>
  Effect.gen(function* () {
    const library = yield* FilterLibrary;
    const results = yield* library.validateAll();
    const summary = {
      ok: results.filter((entry) => entry.ok).length,
      failed: results.filter((entry) => !entry.ok).length
    };
    yield* writeJson({ summary, results });
  })
).pipe(Command.withDescription("Validate all saved filters"));

export const filterCommand = Command.make("filter", {}).pipe(
  Command.withSubcommands([
    filterList,
    filterShow,
    filterCreate,
    filterDelete,
    filterValidateAll
  ])
);

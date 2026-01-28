import { FileSystem, Path } from "@effect/platform";
import { formatSchemaError } from "./shared.js";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Schema } from "effect";
import { FilterExprSchema } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { FilterLibraryError, FilterNotFound } from "../domain/errors.js";
import { StoreName } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

const filtersDirName = "filters";

const ensureTrailingNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;


const toLibraryError = (
  message: string,
  name?: string,
  path?: string,
  cause?: unknown
) =>
  FilterLibraryError.make({
    message,
    name,
    path,
    cause
  });

const encodeFilterJson = (expr: FilterExpr) =>
  Schema.encodeSync(Schema.parseJson(FilterExprSchema))(expr);

const decodeFilterJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(FilterExprSchema))(raw);

const filterPath = (path: Path.Path, root: string, name: StoreName) =>
  path.join(root, filtersDirName, `${name}.json`);

export class FilterLibrary extends Context.Tag("@skygent/FilterLibrary")<
  FilterLibrary,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<string>, FilterLibraryError>;
    readonly get: (
      name: StoreName
    ) => Effect.Effect<
      FilterExpr,
      FilterNotFound | FilterLibraryError
    >;
    readonly save: (
      name: StoreName,
      expr: FilterExpr
    ) => Effect.Effect<void, FilterLibraryError>;
    readonly remove: (
      name: StoreName
    ) => Effect.Effect<void, FilterNotFound | FilterLibraryError>;
    readonly validateAll: () => Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly error?: string }>,
      FilterLibraryError
    >;
  }
>() {
  static readonly layer = Layer.effect(
    FilterLibrary,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = path.join(config.storeRoot, filtersDirName);

      const list = Effect.fn("FilterLibrary.list")(() =>
        fs.readDirectory(rootDir).pipe(
          Effect.catchTag("SystemError", (error) =>
            error.reason === "NotFound" ? Effect.succeed([]) : Effect.fail(error)
          ),
          Effect.map((entries) =>
            entries
              .filter((entry) => entry.endsWith(".json"))
              .map((entry) => entry.slice(0, -".json".length))
              .sort()
          ),
          Effect.mapError((error) =>
            toLibraryError("Failed to list filters", undefined, rootDir, error)
          )
        )
      );

      const get = Effect.fn("FilterLibrary.get")((name: StoreName) => {
        const filePath = filterPath(path, config.storeRoot, name);
        return fs.readFileString(filePath).pipe(
          Effect.mapError((error: PlatformError) =>
            error._tag === "SystemError" && error.reason === "NotFound"
              ? FilterNotFound.make({ name })
              : toLibraryError(
                  `Failed to read filter "${name}"`,
                  name,
                  filePath,
                  error
                )
          ),
          Effect.flatMap((raw) =>
            decodeFilterJson(raw).pipe(
              Effect.mapError((error) =>
                toLibraryError(
                  `Invalid filter JSON for "${name}": ${formatSchemaError(error)}`,
                  name,
                  filePath,
                  error
                )
              )
            )
          )
        );
      });

      const save = Effect.fn("FilterLibrary.save")(
        (name: StoreName, expr: typeof FilterExprSchema.Type) =>
          Effect.gen(function* () {
            const filePath = filterPath(path, config.storeRoot, name);
            yield* fs
              .makeDirectory(rootDir, { recursive: true })
              .pipe(
                Effect.mapError((error) =>
                  toLibraryError(
                    `Failed to create filter directory`,
                    name,
                    rootDir,
                    error
                  )
                )
              );
            const json = ensureTrailingNewline(encodeFilterJson(expr));
            yield* fs
              .writeFileString(filePath, json)
              .pipe(
                Effect.mapError((error) =>
                  toLibraryError(
                    `Failed to save filter "${name}"`,
                    name,
                    filePath,
                    error
                  )
                )
              );
          })
      );

      const remove = Effect.fn("FilterLibrary.remove")((name: StoreName) => {
        const filePath = filterPath(path, config.storeRoot, name);
        return fs.remove(filePath).pipe(
          Effect.mapError((error: PlatformError) =>
            error._tag === "SystemError" && error.reason === "NotFound"
              ? FilterNotFound.make({ name })
              : toLibraryError(
                  `Failed to delete filter "${name}"`,
                  name,
                  filePath,
                  error
                )
          )
        );
      });

      const validateAll = Effect.fn("FilterLibrary.validateAll")(() =>
        Effect.gen(function* () {
          const names = yield* list();
          const results = yield* Effect.forEach(
            names,
            (name) =>
              Schema.decodeUnknown(StoreName)(name).pipe(
                Effect.mapError((error) =>
                  toLibraryError(
                    `Invalid filter name "${name}": ${formatSchemaError(error)}`,
                    name,
                    rootDir,
                    error
                  )
                ),
                Effect.flatMap((decoded) =>
                  get(decoded).pipe(
                    Effect.as({ name, ok: true } as const),
                    Effect.catchAll((error) =>
                      Effect.succeed({
                        name,
                        ok: false,
                        error:
                          error instanceof FilterNotFound
                            ? `Filter "${name}" not found`
                            : error instanceof FilterLibraryError
                              ? error.message
                              : String(error)
                      })
                    )
                  )
                ),
                Effect.catchAll((error) =>
                  Effect.succeed({
                    name,
                    ok: false,
                    error:
                      error instanceof FilterLibraryError
                        ? error.message
                        : String(error)
                  })
                )
              ),
            { discard: false }
          );
          return results;
        })
      );

      return FilterLibrary.of({ list, get, save, remove, validateAll });
    })
  );
}

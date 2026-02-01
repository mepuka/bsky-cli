/**
 * Filter Library Service
 *
 * Manages a library of saved filter expressions stored as JSON files.
 * Filters are persisted in the `~/.skygent/filters/` directory, with each
 * filter saved as a separate `.json` file named after the filter.
 *
 * This service enables users to create reusable filter expressions that can
 * be referenced by name in commands and other operations. Filters are validated
 * against the FilterExprSchema to ensure they conform to the expected structure.
 *
 * @module services/filter-library
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { FilterLibrary } from "./services/filter-library.js";
 * import { StoreName } from "./domain/primitives.js";
 * import type { FilterExpr } from "./domain/filter.js";
 *
 * const program = Effect.gen(function* () {
 *   const library = yield* FilterLibrary;
 *
 *   // List all saved filters
 *   const filters = yield* library.list();
 *   console.log("Available filters:", filters);
 *
 *   // Save a filter expression
 *   const myFilter: FilterExpr = { and: [{ hasText: "hello" }] };
 *   yield* library.save(StoreName.make("greetings"), myFilter);
 *
 *   // Retrieve a saved filter
 *   const retrieved = yield* library.get(StoreName.make("greetings"));
 *
 *   // Validate all saved filters
 *   const validationResults = yield* library.validateAll();
 * });
 * ```
 */

import { FileSystem, Path } from "@effect/platform";
import { formatSchemaError } from "./shared.js";
import { SystemError, type PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Schema } from "effect";
import { FilterExprSchema } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { FilterLibraryError, FilterNotFound } from "../domain/errors.js";
import { StoreName } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

/** Directory name for storing filter JSON files */
const filtersDirName = "filters";

/**
 * Ensures a string ends with a newline character.
 * Used for consistent file formatting when saving JSON files.
 * @param value - The string to ensure has a trailing newline
 * @returns The string with a trailing newline if it didn't have one
 */
const ensureTrailingNewline = (value: string) =>
  value.endsWith("\n") ? value : `${value}\n`;

const isNotFoundSystemError = (error: PlatformError) =>
  Schema.is(SystemError)(error) && error.reason === "NotFound";

/**
 * Creates a FilterLibraryError with contextual information.
 * @param message - Human-readable error message
 * @param name - Optional filter name associated with the error
 * @param path - Optional file path associated with the error
 * @param cause - Optional underlying cause of the error
 * @returns A FilterLibraryError instance
 */
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

/**
 * Encodes a filter expression to JSON string.
 * Validates the expression against FilterExprSchema during encoding.
 * @param expr - The filter expression to encode
 * @returns JSON string representation of the filter
 */
const encodeFilterJson = (expr: FilterExpr) =>
  Schema.encodeSync(Schema.parseJson(FilterExprSchema))(expr);

/**
 * Decodes a JSON string to a filter expression.
 * Validates the JSON against FilterExprSchema during decoding.
 * @param raw - The JSON string to decode
 * @returns An Effect that resolves to the decoded FilterExpr
 */
const decodeFilterJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(FilterExprSchema))(raw);

/**
 * Constructs the file path for a filter's JSON file.
 * @param path - Path utility from Effect platform
 * @param root - Root directory for the application
 * @param name - Name of the filter (becomes the filename)
 * @returns Full path to the filter's JSON file
 */
const filterPath = (path: Path.Path, root: string, name: StoreName) =>
  path.join(root, filtersDirName, `${name}.json`);

/**
 * Effect Context Tag for the Filter Library service.
 * Manages persistent storage of filter expressions as JSON files.
 *
 * Filters are stored in `~/.skygent/filters/` with each filter as a separate
 * `.json` file. The filter name becomes the filename (e.g., `myfilter.json`).
 *
 * @example
 * ```ts
 * // Use in an Effect program
 * const program = Effect.gen(function* () {
 *   const library = yield* FilterLibrary;
 *
 *   // Save a filter
 *   yield* library.save(StoreName.make("tech-posts"), {
 *     and: [
 *       { hasText: "javascript" },
 *       { or: [{ hasText: "typescript" }, { hasText: "node" }] }
 *     ]
 *   });
 *
 *   // List all filters
 *   const filters = yield* library.list();
 *
 *   // Load a filter
 *   const filter = yield* library.get(StoreName.make("tech-posts"));
 * });
 *
 * // Provide the layer
 * const runnable = program.pipe(Effect.provide(FilterLibrary.layer));
 * ```
 */
export class FilterLibrary extends Context.Tag("@skygent/FilterLibrary")<
  FilterLibrary,
  {
    /**
     * Lists all saved filter names.
     * Returns filter names without the `.json` extension, sorted alphabetically.
     * Returns an empty array if the filters directory doesn't exist.
     * @returns An Effect that resolves to an array of filter names
     * @throws {FilterLibraryError} If listing filters fails
     */
    readonly list: () => Effect.Effect<ReadonlyArray<string>, FilterLibraryError>;

    /**
     * Retrieves a saved filter expression by name.
     * @param name - The name of the filter to retrieve
     * @returns An Effect that resolves to the filter expression
     * @throws {FilterNotFound} If the filter doesn't exist
     * @throws {FilterLibraryError} If reading or parsing the filter fails
     */
    readonly get: (
      name: StoreName
    ) => Effect.Effect<
      FilterExpr,
      FilterNotFound | FilterLibraryError
    >;

    /**
     * Saves a filter expression to the library.
     * Creates the filters directory if it doesn't exist.
     * Overwrites existing filters with the same name.
     * @param name - The name for the filter
     * @param expr - The filter expression to save
     * @returns An Effect that resolves when the filter is saved
     * @throws {FilterLibraryError} If saving fails
     */
    readonly save: (
      name: StoreName,
      expr: FilterExpr
    ) => Effect.Effect<void, FilterLibraryError>;

    /**
     * Removes a filter from the library.
     * @param name - The name of the filter to remove
     * @returns An Effect that resolves when the filter is removed
     * @throws {FilterNotFound} If the filter doesn't exist
     * @throws {FilterLibraryError} If removing fails
     */
    readonly remove: (
      name: StoreName
    ) => Effect.Effect<void, FilterNotFound | FilterLibraryError>;

    /**
     * Validates all saved filters.
     * Checks each filter for proper JSON syntax and valid filter expression structure.
     * Returns results for each filter indicating success or failure with error details.
     * @returns An Effect that resolves to validation results for each filter
     * @throws {FilterLibraryError} If the validation process itself fails
     */
    readonly validateAll: () => Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly error?: string }>,
      FilterLibraryError
    >;
  }
>() {
  /**
   * Production layer that provides the FilterLibrary service.
   * Requires FileSystem, Path, and AppConfigService to be provided.
   *
   * The implementation stores filters as JSON files in the filters directory,
   * with each filter named `{filterName}.json`.
   */
  static readonly layer = Layer.effect(
    FilterLibrary,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = path.join(config.storeRoot, filtersDirName);

      /**
       * Lists all saved filters by reading the filters directory.
       * Returns empty array if directory doesn't exist.
       */
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
            isNotFoundSystemError(error)
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
            isNotFoundSystemError(error)
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

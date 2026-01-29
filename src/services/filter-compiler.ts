/**
 * Filter Compiler Service
 *
 * Validates and compiles filter specifications for Bluesky post filtering.
 * Ensures filter expressions are well-formed before they are stored or used.
 *
 * **Validation includes:**
 * - Regex pattern syntax validation
 * - Required field presence (e.g., handles in AuthorIn, tags in HashtagIn)
 * - Logical constraints (e.g., DateRange start before end)
 * - Policy validation (e.g., Retry parameters)
 * - Nested expression validation (And, Or, Not combinators)
 *
 * The compiler performs structural validation without executing filters
 * against actual data. Use the compiled filter expressions with the
 * FilterEvaluator for runtime filtering.
 *
 * **Error Handling:**
 * Returns FilterCompileError with descriptive messages for any validation
 * failures, enabling CLI-friendly error reporting.
 *
 * @module services/filter-compiler
 *
 * @example
 * ```typescript
 * import { FilterCompiler } from "./services/filter-compiler.js";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const compiler = yield* FilterCompiler;
 *
 *   // Compile a filter spec
 *   const filterExpr = yield* compiler.compile({
 *     expr: { _tag: "Contains", text: "bluesky" }
 *   });
 *
 *   // Or validate an existing expression
 *   yield* compiler.validate(filterExpr);
 * }).pipe(Effect.provide(FilterCompiler.layer));
 * ```
 */

import { Context, Duration, Effect, Layer } from "effect";
import { FilterCompileError } from "../domain/errors.js";
import type { FilterExpr } from "../domain/filter.js";
import type { FilterErrorPolicy } from "../domain/policies.js";
import type { FilterSpec } from "../domain/store.js";

const invalid = (message: string) => FilterCompileError.make({ message });

const messageFromError = (error: unknown) => {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const validatePolicy: (policy: FilterErrorPolicy) => Effect.Effect<void, FilterCompileError> =
  Effect.fn("FilterCompiler.validatePolicy")((policy: FilterErrorPolicy) => {
    switch (policy._tag) {
      case "Include":
      case "Exclude":
        return Effect.void;
      case "Retry":
        return Effect.gen(function* () {
          if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
            return yield* invalid(
              `Retry maxRetries must be a non-negative integer (got ${policy.maxRetries})`
            );
          }
          if (!Duration.isFinite(policy.baseDelay)) {
            return yield* invalid(
              "Retry baseDelay must be a finite duration"
            );
          }
          return;
        });
    }
  });

const validateRegex = (patterns: ReadonlyArray<string>, flags?: string) =>
  Effect.gen(function* () {
    if (patterns.length === 0) {
      return yield* invalid("Regex patterns must contain at least one entry");
    }
    yield* Effect.forEach(
      patterns,
      (pattern) =>
        Effect.try({
          try: () => {
            RegExp(pattern, flags);
          },
          catch: (error) =>
            invalid(`Invalid regex "${pattern}": ${messageFromError(error)}`)
        }),
      { discard: true }
    );
  });

const validateExpr: (expr: FilterExpr) => Effect.Effect<void, FilterCompileError> =
  Effect.fn("FilterCompiler.validateExpr")(function* (expr: FilterExpr) {
    switch (expr._tag) {
      case "All":
      case "None":
      case "Author":
      case "Hashtag":
        return;
      case "AuthorIn":
        if (expr.handles.length === 0) {
          return yield* invalid("AuthorIn handles must contain at least one entry");
        }
        return;
      case "HashtagIn":
        if (expr.tags.length === 0) {
          return yield* invalid("HashtagIn tags must contain at least one entry");
        }
        return;
      case "Contains":
        if (expr.text.trim().length === 0) {
          return yield* invalid("Contains text must be non-empty");
        }
        return;
      case "IsReply":
      case "IsQuote":
      case "IsRepost":
      case "IsOriginal":
      case "HasImages":
      case "HasVideo":
      case "HasLinks":
      case "HasMedia":
        return;
      case "Language":
        if (expr.langs.length === 0) {
          return yield* invalid("Language langs must contain at least one entry");
        }
        return;
      case "Engagement":
        if (
          expr.minLikes === undefined &&
          expr.minReposts === undefined &&
          expr.minReplies === undefined
        ) {
          return yield* invalid(
            "Engagement requires at least one threshold (minLikes, minReposts, minReplies)"
          );
        }
        return;
      case "Regex":
        return yield* validateRegex(expr.patterns, expr.flags);
      case "DateRange":
        if (expr.start.getTime() >= expr.end.getTime()) {
          return yield* invalid("DateRange start must be before end");
        }
        return;
      case "And":
        yield* validateExpr(expr.left);
        return yield* validateExpr(expr.right);
      case "Or":
        yield* validateExpr(expr.left);
        return yield* validateExpr(expr.right);
      case "Not":
        return yield* validateExpr(expr.expr);
      case "HasValidLinks":
        return yield* validatePolicy(expr.onError);
      case "Trending":
        return yield* validatePolicy(expr.onError);
      default:
        return yield* invalid(
          `Unknown filter tag: ${(expr as { _tag: string })._tag}`
        );
    }
  });

/**
 * Context tag and Layer implementation for the filter compiler service.
 * Provides compile-time validation of filter expressions.
 *
 * **Supported Filter Types:**
 * - Basic: All, None, Author, Hashtag, Contains, IsReply, IsQuote, IsRepost
 * - Collections: AuthorIn, HashtagIn (require non-empty arrays)
 * - Media: HasImages, HasVideo, HasLinks, HasMedia
 * - Metadata: Language (requires langs array), Engagement (requires at least one threshold)
 * - Time: DateRange (start must be before end)
 * - Text: Regex (validates pattern syntax)
 * - Combinators: And, Or, Not (recursively validates children)
 * - Async: HasValidLinks, Trending (validates error policy)
 *
 * @example
 * ```typescript
 * // Basic compilation
 * const spec = { expr: { _tag: "Author", handle: "user.bsky.social" } };
 * const compiled = yield* compiler.compile(spec);
 *
 * // Regex validation
 * const regexFilter = {
 *   expr: { _tag: "Regex", patterns: ["^test$", "[invalid"], flags: "i" }
 * };
 * // Fails with: Invalid regex "[invalid": Invalid regular expression
 *
 * // Combinator validation
 * const complexFilter = {
 *   expr: {
 *     _tag: "And",
 *     left: { _tag: "HasImages" },
 *     right: {
 *       _tag: "Or",
 *       left: { _tag: "Contains", text: "photo" },
 *       right: { _tag: "Contains", text: "picture" }
 *     }
 *   }
 * };
 * yield* compiler.compile(complexFilter); // OK
 * ```
 */
export class FilterCompiler extends Context.Tag("@skygent/FilterCompiler")<
  FilterCompiler,
  {
    /**
     * Compiles a filter spec by validating its expression.
     * Returns the original expression if valid.
     *
     * @param spec - The filter specification containing the expression to validate
     * @returns Effect resolving to the validated FilterExpr
     * @throws {FilterCompileError} When validation fails with detailed message
     */
    readonly compile: (spec: FilterSpec) => Effect.Effect<FilterExpr, FilterCompileError>;

    /**
     * Validates a filter expression without a spec wrapper.
     * Useful for re-validating expressions or standalone validation.
     *
     * @param expr - The filter expression to validate
     * @returns Effect resolving to void on success
     * @throws {FilterCompileError} When validation fails
     */
    readonly validate: (expr: FilterExpr) => Effect.Effect<void, FilterCompileError>;
  }
>() {
  /**
   * Layer that provides the filter compiler service.
   * Stateless service with no dependencies.
   */
  static readonly layer = Layer.succeed(
    FilterCompiler,
    FilterCompiler.of({
      /**
       * Compiles a filter specification by validating its expression.
       * Returns the expression unchanged if valid.
       *
       * @param spec - Filter specification with expr field
       * @returns Validated filter expression
       */
      compile: Effect.fn("FilterCompiler.compile")((spec: FilterSpec) =>
        validateExpr(spec.expr).pipe(Effect.as(spec.expr))
      ),

      /**
       * Validates a filter expression recursively.
       * Checks all constraints based on expression type.
       *
       * @param expr - Filter expression to validate
       * @returns Effect that succeeds if valid, fails with FilterCompileError otherwise
       */
      validate: Effect.fn("FilterCompiler.validate")(validateExpr)
    })
  );
}

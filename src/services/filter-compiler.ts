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

import { Duration, Effect, Match } from "effect";
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
    return Match.type<FilterErrorPolicy>().pipe(
      Match.tagsExhaustive({
        Include: () => Effect.void,
        Exclude: () => Effect.void,
        Retry: (retryPolicy) =>
          Effect.gen(function* () {
            if (!Number.isInteger(retryPolicy.maxRetries) || retryPolicy.maxRetries < 0) {
              return yield* invalid(
                `Retry maxRetries must be a non-negative integer (got ${retryPolicy.maxRetries})`
              );
            }
            if (!Duration.isFinite(retryPolicy.baseDelay)) {
              return yield* invalid(
                "Retry baseDelay must be a finite duration"
              );
            }
            return;
          })
      })
    )(policy);
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
  Effect.fn("FilterCompiler.validateExpr")((expr: FilterExpr) =>
    Match.type<FilterExpr>().pipe(
      Match.tagsExhaustive({
        All: () => Effect.void,
        None: () => Effect.void,
        Author: () => Effect.void,
        Hashtag: () => Effect.void,
        AuthorIn: (authorIn) =>
          authorIn.handles.length === 0
            ? invalid("AuthorIn handles must contain at least one entry")
            : Effect.void,
        HashtagIn: (hashtagIn) =>
          hashtagIn.tags.length === 0
            ? invalid("HashtagIn tags must contain at least one entry")
            : Effect.void,
        Contains: (contains) =>
          contains.text.trim().length === 0
            ? invalid("Contains text must be non-empty")
            : Effect.void,
        IsReply: () => Effect.void,
        IsQuote: () => Effect.void,
        IsRepost: () => Effect.void,
        IsOriginal: () => Effect.void,
        HasImages: () => Effect.void,
        HasAltText: () => Effect.void,
        NoAltText: () => Effect.void,
        HasVideo: () => Effect.void,
        HasLinks: () => Effect.void,
        LinkContains: (link) =>
          link.text.trim().length === 0
            ? invalid("LinkContains text must be non-empty")
            : Effect.void,
        LinkRegex: (linkRegex) =>
          validateRegex([linkRegex.pattern], linkRegex.flags),
        HasMedia: () => Effect.void,
        HasEmbed: () => Effect.void,
        MinImages: (minImages) =>
          !Number.isInteger(minImages.min) || minImages.min < 1
            ? invalid("MinImages requires min >= 1")
            : Effect.void,
        AltText: (altText) =>
          altText.text.trim().length === 0
            ? invalid("AltText text must be non-empty")
            : Effect.void,
        AltTextRegex: (altTextRegex) =>
          validateRegex([altTextRegex.pattern], altTextRegex.flags),
        Language: (language) =>
          language.langs.length === 0
            ? invalid("Language langs must contain at least one entry")
            : Effect.void,
        Engagement: (engagement) =>
          engagement.minLikes === undefined &&
          engagement.minReposts === undefined &&
          engagement.minReplies === undefined
            ? invalid(
                "Engagement requires at least one threshold (minLikes, minReposts, minReplies)"
              )
            : Effect.void,
        Regex: (regex) => validateRegex(regex.patterns, regex.flags),
        DateRange: (range) =>
          range.start.getTime() >= range.end.getTime()
            ? invalid("DateRange start must be before end")
            : Effect.void,
        And: (andExpr) =>
          Effect.gen(function* () {
            yield* validateExpr(andExpr.left);
            yield* validateExpr(andExpr.right);
          }),
        Or: (orExpr) =>
          Effect.gen(function* () {
            yield* validateExpr(orExpr.left);
            yield* validateExpr(orExpr.right);
          }),
        Not: (notExpr) => validateExpr(notExpr.expr),
        HasValidLinks: (links) => validatePolicy(links.onError),
        Trending: (trending) => validatePolicy(trending.onError)
      })
    )(expr)
  );

/**
 * Context tag and Layer implementation for the filter compiler service.
 * Provides compile-time validation of filter expressions.
 *
 * **Supported Filter Types:**
 * - Basic: All, None, Author, Hashtag, Contains, IsReply, IsQuote, IsRepost
 * - Collections: AuthorIn, HashtagIn (require non-empty arrays)
 * - Media: HasImages, MinImages, HasAltText, NoAltText, AltText, AltTextRegex, HasVideo, HasLinks, LinkContains, LinkRegex, HasMedia, HasEmbed
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
export class FilterCompiler extends Effect.Service<FilterCompiler>()("@skygent/FilterCompiler", {
  succeed: {
    compile: Effect.fn("FilterCompiler.compile")((spec: FilterSpec) =>
      validateExpr(spec.expr).pipe(Effect.as(spec.expr))
    ),
    validate: Effect.fn("FilterCompiler.validate")(validateExpr)
  }
}) {
  static readonly layer = FilterCompiler.Default;
}

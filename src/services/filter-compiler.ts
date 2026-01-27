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
        if (expr.start.getTime() > expr.end.getTime()) {
          return yield* invalid("DateRange start must be before or equal to end");
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
      case "Llm":
        if (expr.minConfidence < 0 || expr.minConfidence > 1) {
          return yield* invalid("Llm minConfidence must be between 0 and 1");
        }
        return yield* validatePolicy(expr.onError);
      default:
        return yield* invalid(
          `Unknown filter tag: ${(expr as { _tag: string })._tag}`
        );
    }
  });

export class FilterCompiler extends Context.Tag("@skygent/FilterCompiler")<
  FilterCompiler,
  {
    readonly compile: (spec: FilterSpec) => Effect.Effect<FilterExpr, FilterCompileError>;
  }
>() {
  static readonly layer = Layer.succeed(
    FilterCompiler,
    FilterCompiler.of({
      compile: Effect.fn("FilterCompiler.compile")((spec: FilterSpec) =>
        validateExpr(spec.expr).pipe(Effect.as(spec.expr))
      )
    })
  );
}

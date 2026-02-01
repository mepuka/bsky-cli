/**
 * Filter runtime service for compiling and evaluating filter expressions against posts.
 *
 * This service provides the core filtering logic for Skygent. It compiles filter
 * expressions into executable predicates and supports both synchronous and effectful
 * filters. Effectful filters (like `HasValidLinks` and `Trending`) can perform
 * external operations such as HTTP requests.
 *
 * ## Features
 *
 * - **Filter compilation**: Converts FilterExpr AST into executable predicates
 * - **Effectful filters**: Supports filters requiring async operations with retry policies
 * - **Batch evaluation**: Efficiently evaluates filters against multiple posts
 * - **Explanation mode**: Provides detailed reasoning for filter decisions
 * - **Error policies**: Configurable handling of filter evaluation errors (Include/Exclude/Retry)
 *
 * ## Filter Types
 *
 * ### Simple Filters
 * - `All`, `None`: Identity filters
 * - `Author`, `AuthorIn`: Match by author handle
 * - `Hashtag`, `HashtagIn`: Match by hashtag
 * - `Contains`: Text substring matching
 * - `IsReply`, `IsQuote`, `IsRepost`, `IsOriginal`: Post type matching
 * - `HasImages`, `MinImages`, `HasAltText`, `NoAltText`, `AltText`, `AltTextRegex`, `HasVideo`, `HasLinks`, `HasMedia`, `HasEmbed`: Media detection
 * - `Engagement`: Threshold-based engagement matching
 * - `Language`: Language code matching
 * - `Regex`: Regular expression pattern matching
 * - `DateRange`: Creation date range matching
 *
 * ### Effectful Filters
 * - `HasValidLinks`: Validates external links via HTTP requests
 * - `Trending`: Checks hashtag trending status via Bluesky API
 *
 * ### Composite Filters
 * - `And`, `Or`: Logical composition
 * - `Not`: Logical negation
 *
 * ## Error Handling
 *
 * Effectful filters use `FilterErrorPolicy` to determine behavior on failure:
 * - `Include`: Treat errors as matching (include the post)
 * - `Exclude`: Treat errors as non-matching (exclude the post)
 * - `Retry`: Retry with exponential backoff
 *
 * ## Dependencies
 *
 * - `LinkValidator`: For validating external links
 * - `TrendingTopics`: For checking trending hashtag status
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { FilterRuntime } from "./services/filter-runtime.js";
 * import { and, hashtag, author } from "./domain/filter.js";
 *
 * const program = Effect.gen(function* () {
 *   const runtime = yield* FilterRuntime;
 *
 *   // Compile a filter expression
 *   const predicate = yield* runtime.evaluate(
 *     and(hashtag("tech"), author("@alice.bsky.social"))
 *   );
 *
 *   // Evaluate against a post
 *   const matches = yield* predicate(post);
 * });
 * ```
 *
 * @module services/filter-runtime
 */

import { Chunk, Context, Duration, Effect, Layer, Schedule } from "effect";
import { FilterCompileError, FilterEvalError } from "../domain/errors.js";
import type { FilterExpr } from "../domain/filter.js";
import type { FilterErrorPolicy } from "../domain/policies.js";
import type { Post } from "../domain/post.js";
import type { FilterExplanation } from "../domain/filter-explain.js";
import { extractImageRefs } from "../domain/embeds.js";
import type { LinkValidatorService } from "./link-validator.js";
import type { TrendingTopicsService } from "./trending-topics.js";

const regexMatches = (regex: RegExp, text: string) => {
  if (regex.global || regex.sticky) {
    return new RegExp(regex.source, regex.flags).test(text);
  }
  return regex.test(text);
};
import { LinkValidator } from "./link-validator.js";
import { TrendingTopics } from "./trending-topics.js";
import { FilterSettings } from "./filter-settings.js";

type Predicate = (post: Post) => Effect.Effect<boolean, FilterEvalError>;
type Explainer = (post: Post) => Effect.Effect<FilterExplanation, FilterEvalError>;

const embedTag = (embed: Post["embed"]): string | undefined => {
  if (!embed || typeof embed !== "object" || !("_tag" in embed)) {
    return undefined;
  }
  const tag = (embed as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const embedMediaTag = (embed: Post["embed"]): string | undefined => {
  if (!embed || typeof embed !== "object" || !("_tag" in embed)) {
    return undefined;
  }
  const tag = (embed as { readonly _tag?: unknown })._tag;
  if (tag !== "RecordWithMedia") {
    return undefined;
  }
  const media = (embed as { readonly media?: unknown }).media;
  if (!media || typeof media !== "object" || !("_tag" in media)) {
    return undefined;
  }
  const mediaTag = (media as { readonly _tag?: unknown })._tag;
  return typeof mediaTag === "string" ? mediaTag : undefined;
};

const hasExternalLink = (post: Post) => {
  if (post.links.length > 0) {
    return true;
  }
  const tag = embedTag(post.embed);
  if (tag === "External") {
    return true;
  }
  return embedMediaTag(post.embed) === "External";
};

const imageRefs = (post: Post) => extractImageRefs(post.embed);

const hasImages = (post: Post) => imageRefs(post).length > 0;

const hasAltText = (post: Post) => {
  const refs = imageRefs(post);
  if (refs.length === 0) return false;
  return refs.every((ref) => typeof ref.alt === "string" && ref.alt.trim().length > 0);
};

const hasMissingAltText = (post: Post) => {
  const refs = imageRefs(post);
  if (refs.length === 0) return false;
  return refs.some((ref) => !ref.alt || ref.alt.trim().length === 0);
};

const altTextMatches = (post: Post, predicate: (value: string) => boolean) => {
  const refs = imageRefs(post);
  for (const ref of refs) {
    if (ref.alt && predicate(ref.alt)) {
      return true;
    }
  }
  return false;
};

const hasVideo = (post: Post) => {
  const tag = embedTag(post.embed);
  if (tag === "Video") {
    return true;
  }
  return embedMediaTag(post.embed) === "Video";
};

const hasMedia = (post: Post) =>
  hasImages(post) || hasVideo(post) || hasExternalLink(post);

const hasEmbed = (post: Post) =>
  post.embed != null || post.recordEmbed != null;

const isRepost = (post: Post) => {
  const reason = post.feed?.reason;
  if (!reason || typeof reason !== "object") {
    return false;
  }
  const tag = (reason as { readonly _tag?: unknown })._tag;
  return tag === "ReasonRepost";
};

const isQuote = (post: Post) => {
  const tag = embedTag(post.embed);
  return tag === "Record" || tag === "RecordWithMedia";
};

const withPolicy = (
  policy: FilterErrorPolicy,
  effect: Effect.Effect<boolean, FilterEvalError>
): Effect.Effect<boolean, FilterEvalError> => {
  switch (policy._tag) {
    case "Include":
      return effect.pipe(Effect.catchAll(() => Effect.succeed(true)));
    case "Exclude":
      return effect.pipe(Effect.catchAll(() => Effect.succeed(false)));
    case "Retry": {
      if (!Duration.isFinite(policy.baseDelay)) {
        return Effect.fail(
          FilterEvalError.make({ message: "Retry baseDelay must be finite" })
        );
      }
      const delay = policy.baseDelay;
      const schedule = Schedule.addDelay(
        Schedule.recurs(policy.maxRetries),
        () => delay
      );
      return effect.pipe(Effect.retry(schedule));
    }
  }
};

const messageFromError = (error: unknown) => {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const retryScheduleFor = (policy: Extract<FilterErrorPolicy, { _tag: "Retry" }>) => {
  if (!Duration.isFinite(policy.baseDelay)) {
    return FilterEvalError.make({ message: "Retry baseDelay must be finite" });
  }
  return Schedule.addDelay(Schedule.recurs(policy.maxRetries), () => policy.baseDelay);
};

const explainPolicy = <A>(
  policy: FilterErrorPolicy,
  effect: Effect.Effect<A, FilterEvalError>,
  onSuccess: (value: A) => FilterExplanation,
  onError: (error: FilterEvalError, policyTag: "Include" | "Exclude") => FilterExplanation
): Effect.Effect<FilterExplanation, FilterEvalError> => {
  switch (policy._tag) {
    case "Include":
    case "Exclude":
      return effect.pipe(
        Effect.match({
          onSuccess,
          onFailure: (error) => onError(error, policy._tag)
        })
      );
    case "Retry": {
      const schedule = retryScheduleFor(policy);
      if (schedule instanceof FilterEvalError) {
        return Effect.fail(schedule);
      }
      return effect.pipe(Effect.retry(schedule), Effect.map(onSuccess));
    }
  }
};

const skippedNode = (expr: FilterExpr, reason: string): FilterExplanation => ({
  _tag: expr._tag,
  ok: false,
  skipped: true,
  detail: reason
});

const buildExplanation = (
  links: LinkValidatorService,
  trending: TrendingTopicsService
): ((expr: FilterExpr) => Effect.Effect<Explainer, FilterCompileError>) =>
  Effect.fn("FilterRuntime.buildExplanation")(function* (expr: FilterExpr) {
    switch (expr._tag) {
      case "All":
        return (_post: Post) => Effect.succeed({ _tag: "All", ok: true });
      case "None":
        return (_post: Post) => Effect.succeed({ _tag: "None", ok: false });
      case "Author":
        return (post: Post) =>
          Effect.succeed({
            _tag: "Author",
            ok: post.author === expr.handle,
            detail: `author=${post.author}, expected=${expr.handle}`
          });
      case "Hashtag":
        return (post: Post) => {
          const matched = post.hashtags.find((tag) => tag === expr.tag);
          return Effect.succeed({
            _tag: "Hashtag",
            ok: matched !== undefined,
            detail: matched
              ? `matched=${matched}`
              : `hashtags=${post.hashtags.join(",") || "none"}`
          });
        };
      case "AuthorIn": {
        const handles = new Set(expr.handles);
        return (post: Post) =>
          Effect.succeed({
            _tag: "AuthorIn",
            ok: handles.has(post.author),
            detail: `author=${post.author}`
          });
      }
      case "HashtagIn": {
        const tags = new Set(expr.tags);
        return (post: Post) => {
          const matched = post.hashtags.find((tag) => tags.has(tag));
          return Effect.succeed({
            _tag: "HashtagIn",
            ok: matched !== undefined,
            detail: matched
              ? `matched=${matched}`
              : `hashtags=${post.hashtags.join(",") || "none"}`
          });
        };
      }
      case "Contains": {
        const needle = expr.caseSensitive ? expr.text : expr.text.toLowerCase();
        return (post: Post) => {
          const haystack = expr.caseSensitive ? post.text : post.text.toLowerCase();
          const ok = haystack.includes(needle);
          return Effect.succeed({
            _tag: "Contains",
            ok,
            detail: `caseSensitive=${expr.caseSensitive ?? false}`
          });
        };
      }
      case "IsReply":
        return (post: Post) =>
          Effect.succeed({
            _tag: "IsReply",
            ok: !!post.reply,
            detail: `reply=${Boolean(post.reply)}`
          });
      case "IsQuote":
        return (post: Post) =>
          Effect.succeed({
            _tag: "IsQuote",
            ok: isQuote(post),
            detail: `quote=${isQuote(post)}`
          });
      case "IsRepost":
        return (post: Post) =>
          Effect.succeed({
            _tag: "IsRepost",
            ok: isRepost(post),
            detail: `repost=${isRepost(post)}`
          });
      case "IsOriginal":
        return (post: Post) => {
          const ok = !post.reply && !isQuote(post) && !isRepost(post);
          return Effect.succeed({
            _tag: "IsOriginal",
            ok,
            detail: `reply=${Boolean(post.reply)}, quote=${isQuote(post)}, repost=${isRepost(post)}`
          });
        };
      case "Engagement":
        return (post: Post) => {
          const metrics = post.metrics;
          const likes = metrics?.likeCount ?? 0;
          const reposts = metrics?.repostCount ?? 0;
          const replies = metrics?.replyCount ?? 0;
          const passes = (min: number | undefined, value: number) =>
            min === undefined || value >= min;
          const ok =
            passes(expr.minLikes, likes) &&
            passes(expr.minReposts, reposts) &&
            passes(expr.minReplies, replies);
          return Effect.succeed({
            _tag: "Engagement",
            ok,
            detail: `likes=${likes}, reposts=${reposts}, replies=${replies}`
          });
        };
      case "HasImages":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasImages",
            ok: hasImages(post),
            detail: `hasImages=${hasImages(post)}`
          });
      case "MinImages":
        return (post: Post) => {
          const count = imageRefs(post).length;
          const ok = count >= expr.min;
          return Effect.succeed({
            _tag: "MinImages",
            ok,
            detail: `imageCount=${count}, min=${expr.min}`
          });
        };
      case "HasAltText":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasAltText",
            ok: hasAltText(post),
            detail: `hasAltText=${hasAltText(post)}`
          });
      case "NoAltText":
        return (post: Post) =>
          Effect.succeed({
            _tag: "NoAltText",
            ok: hasMissingAltText(post),
            detail: `missingAltText=${hasMissingAltText(post)}`
          });
      case "AltText": {
        const needle = expr.text.toLowerCase();
        return (post: Post) =>
          Effect.succeed({
            _tag: "AltText",
            ok: altTextMatches(post, (value) => value.toLowerCase().includes(needle)),
            detail: `needle=${expr.text}`
          });
      }
      case "AltTextRegex": {
        const compiled = yield* Effect.try({
          try: () => new RegExp(expr.pattern, expr.flags),
          catch: (error) =>
            FilterCompileError.make({
              message: `Invalid regex "${expr.pattern}": ${messageFromError(error)}`
            })
        });
        return (post: Post) =>
          Effect.succeed({
            _tag: "AltTextRegex",
            ok: altTextMatches(post, (value) => regexMatches(compiled, value)),
            detail: `pattern=/${expr.pattern}/${expr.flags ?? ""}`
          });
      }
      case "HasVideo":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasVideo",
            ok: hasVideo(post),
            detail: `hasVideo=${hasVideo(post)}`
          });
      case "HasLinks":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasLinks",
            ok: hasExternalLink(post),
            detail: `links=${post.links.length}`
          });
      case "HasMedia":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasMedia",
            ok: hasMedia(post),
            detail: `hasMedia=${hasMedia(post)}`
          });
      case "HasEmbed":
        return (post: Post) =>
          Effect.succeed({
            _tag: "HasEmbed",
            ok: hasEmbed(post),
            detail: `hasEmbed=${hasEmbed(post)}`
          });
      case "Language": {
        const langs = new Set(expr.langs.map((lang) => lang.toLowerCase()));
        return (post: Post) => {
          if (!post.langs || post.langs.length === 0) {
            return Effect.succeed({
              _tag: "Language",
              ok: false,
              detail: "langs=none"
            });
          }
          const matched = post.langs.find((lang) => langs.has(lang.toLowerCase()));
          return Effect.succeed({
            _tag: "Language",
            ok: matched !== undefined,
            detail: matched
              ? `matched=${matched}`
              : `langs=${post.langs.join(",")}`
          });
        };
      }
      case "Regex": {
        if (expr.patterns.length === 0) {
          return yield* FilterCompileError.make({
            message: "Regex patterns must contain at least one entry"
          });
        }
        const compiled = yield* Effect.forEach(
          expr.patterns,
          (pattern) =>
            Effect.try({
              try: () => new RegExp(pattern, expr.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${pattern}": ${messageFromError(error)}`
                })
            })
        );
        return (post: Post) => {
          const matched = compiled.find((regex) => regexMatches(regex, post.text));
          return Effect.succeed({
            _tag: "Regex",
            ok: matched !== undefined,
            detail: matched
              ? `matched=${matched.source}`
              : `patterns=${expr.patterns.join(",")}`
          });
        };
      }
      case "DateRange":
        return (post: Post) => {
          const created = post.createdAt.getTime();
          const ok =
            created >= expr.start.getTime() && created <= expr.end.getTime();
          return Effect.succeed({
            _tag: "DateRange",
            ok,
            detail: `createdAt=${post.createdAt.toISOString()}`
          });
        };
      case "And": {
        const left = yield* buildExplanation(links, trending)(expr.left);
        const right = yield* buildExplanation(links, trending)(expr.right);
        return (post: Post) =>
          left(post).pipe(
            Effect.flatMap((leftResult) => {
              if (!leftResult.ok) {
                return Effect.succeed({
                  _tag: "And",
                  ok: false,
                  children: [
                    leftResult,
                    skippedNode(expr.right, "Skipped because left side was false.")
                  ]
                });
              }
              return right(post).pipe(
                Effect.map((rightResult) => ({
                  _tag: "And",
                  ok: rightResult.ok,
                  children: [leftResult, rightResult]
                }))
              );
            })
          );
      }
      case "Or": {
        const left = yield* buildExplanation(links, trending)(expr.left);
        const right = yield* buildExplanation(links, trending)(expr.right);
        return (post: Post) =>
          left(post).pipe(
            Effect.flatMap((leftResult) => {
              if (leftResult.ok) {
                return Effect.succeed({
                  _tag: "Or",
                  ok: true,
                  children: [
                    leftResult,
                    skippedNode(expr.right, "Skipped because left side was true.")
                  ]
                });
              }
              return right(post).pipe(
                Effect.map((rightResult) => ({
                  _tag: "Or",
                  ok: rightResult.ok,
                  children: [leftResult, rightResult]
                }))
              );
            })
          );
      }
      case "Not": {
        const inner = yield* buildExplanation(links, trending)(expr.expr);
        return (post: Post) =>
          inner(post).pipe(
            Effect.map((innerResult) => ({
              _tag: "Not",
              ok: !innerResult.ok,
              children: [innerResult]
            }))
          );
      }
      case "HasValidLinks": {
        return (post: Post) => {
          const urls = post.links.map((link) => link.toString());
          return explainPolicy(
            expr.onError,
            links.hasValidLink(urls),
            (ok) => ({
              _tag: "HasValidLinks",
              ok,
              detail: `links=${urls.length}, policy=${expr.onError._tag}`
            }),
            (error, policyTag) => ({
              _tag: "HasValidLinks",
              ok: policyTag === "Include",
              detail: `error=${messageFromError(error)}, policy=${policyTag}`
            })
          );
        };
      }
      case "Trending": {
        return (_post: Post) =>
          explainPolicy(
            expr.onError,
            trending.isTrending(expr.tag),
            (ok) => ({
              _tag: "Trending",
              ok,
              detail: `tag=${expr.tag}, policy=${expr.onError._tag}`
            }),
            (error, policyTag) => ({
              _tag: "Trending",
              ok: policyTag === "Include",
              detail: `error=${messageFromError(error)}, policy=${policyTag}`
            })
          );
      }
      default:
        return yield* FilterCompileError.make({
          message: `Unknown filter tag: ${(expr as { _tag: string })._tag}`
        });
    }
  });

const buildPredicate = (
  links: LinkValidatorService,
  trending: TrendingTopicsService
): ((expr: FilterExpr) => Effect.Effect<Predicate, FilterCompileError>) =>
  Effect.fn("FilterRuntime.buildPredicate")(function* (expr: FilterExpr) {
    switch (expr._tag) {
      case "All":
        return (_post: Post) => Effect.succeed(true);
      case "None":
        return (_post: Post) => Effect.succeed(false);
      case "Author":
        return (post: Post) =>
          Effect.succeed(post.author === expr.handle);
      case "Hashtag":
        return (post: Post) =>
          Effect.succeed(post.hashtags.some((tag) => tag === expr.tag));
      case "AuthorIn": {
        const handles = new Set(expr.handles);
        return (post: Post) =>
          Effect.succeed(handles.has(post.author));
      }
      case "HashtagIn": {
        const tags = new Set(expr.tags);
        return (post: Post) =>
          Effect.succeed(post.hashtags.some((tag) => tags.has(tag)));
      }
      case "Contains": {
        const needle = expr.caseSensitive ? expr.text : expr.text.toLowerCase();
        return (post: Post) => {
          const haystack = expr.caseSensitive ? post.text : post.text.toLowerCase();
          return Effect.succeed(haystack.includes(needle));
        };
      }
      case "IsReply":
        return (post: Post) => Effect.succeed(!!post.reply);
      case "IsQuote":
        return (post: Post) => Effect.succeed(isQuote(post));
      case "IsRepost":
        return (post: Post) => Effect.succeed(isRepost(post));
      case "IsOriginal":
        return (post: Post) =>
          Effect.succeed(!post.reply && !isQuote(post) && !isRepost(post));
      case "Engagement":
        return (post: Post) => {
          const metrics = post.metrics;
          const likes = metrics?.likeCount ?? 0;
          const reposts = metrics?.repostCount ?? 0;
          const replies = metrics?.replyCount ?? 0;
          const passes = (min: number | undefined, value: number) =>
            min === undefined || value >= min;
          return Effect.succeed(
            passes(expr.minLikes, likes) &&
              passes(expr.minReposts, reposts) &&
              passes(expr.minReplies, replies)
          );
        };
      case "HasImages":
        return (post: Post) => Effect.succeed(hasImages(post));
      case "MinImages":
        return (post: Post) => Effect.succeed(imageRefs(post).length >= expr.min);
      case "HasAltText":
        return (post: Post) => Effect.succeed(hasAltText(post));
      case "NoAltText":
        return (post: Post) => Effect.succeed(hasMissingAltText(post));
      case "AltText": {
        const needle = expr.text.toLowerCase();
        return (post: Post) =>
          Effect.succeed(altTextMatches(post, (value) => value.toLowerCase().includes(needle)));
      }
      case "AltTextRegex": {
        const compiled = yield* Effect.try({
          try: () => new RegExp(expr.pattern, expr.flags),
          catch: (error) =>
            FilterCompileError.make({
              message: `Invalid regex "${expr.pattern}": ${messageFromError(error)}`
            })
        });
        return (post: Post) =>
          Effect.succeed(altTextMatches(post, (value) => regexMatches(compiled, value)));
      }
      case "HasVideo":
        return (post: Post) => Effect.succeed(hasVideo(post));
      case "HasLinks":
        return (post: Post) =>
          Effect.succeed(hasExternalLink(post));
      case "HasMedia":
        return (post: Post) => Effect.succeed(hasMedia(post));
      case "HasEmbed":
        return (post: Post) => Effect.succeed(hasEmbed(post));
      case "Language": {
        const langs = new Set(expr.langs.map((lang) => lang.toLowerCase()));
        return (post: Post) => {
          if (!post.langs || post.langs.length === 0) {
            return Effect.succeed(false);
          }
          return Effect.succeed(
            post.langs.some((lang) => langs.has(lang.toLowerCase()))
          );
        };
      }
      case "Regex": {
        if (expr.patterns.length === 0) {
          return yield* FilterCompileError.make({
            message: "Regex patterns must contain at least one entry"
          });
        }
        const compiled = yield* Effect.forEach(
          expr.patterns,
          (pattern) =>
            Effect.try({
              try: () => new RegExp(pattern, expr.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${pattern}": ${messageFromError(error)}`
                })
            })
        );
        return (post: Post) =>
          Effect.succeed(
            compiled.some((regex) => regexMatches(regex, post.text))
          );
      }
      case "DateRange":
        return (post: Post) => {
          const created = post.createdAt.getTime();
          return Effect.succeed(
            created >= expr.start.getTime() && created <= expr.end.getTime()
          );
        };
      case "And": {
        const left = yield* buildPredicate(links, trending)(expr.left);
        const right = yield* buildPredicate(links, trending)(expr.right);
        return (post: Post) =>
          left(post).pipe(
            Effect.flatMap((ok) =>
              ok ? right(post) : Effect.succeed(false)
            )
          );
      }
      case "Or": {
        const left = yield* buildPredicate(links, trending)(expr.left);
        const right = yield* buildPredicate(links, trending)(expr.right);
        return (post: Post) =>
          left(post).pipe(
            Effect.flatMap((ok) =>
              ok ? Effect.succeed(true) : right(post)
            )
          );
      }
      case "Not": {
        const inner = yield* buildPredicate(links, trending)(expr.expr);
        return (post: Post) =>
          inner(post).pipe(Effect.map((ok) => !ok));
      }
      case "HasValidLinks": {
        return (post: Post) =>
          withPolicy(
            expr.onError,
            links.hasValidLink(post.links.map((link) => link.toString()))
          );
      }
      case "Trending": {
        return (_post: Post) =>
          withPolicy(expr.onError, trending.isTrending(expr.tag));
      }
      default:
        return yield* FilterCompileError.make({
          message: `Unknown filter tag: ${(expr as { _tag: string })._tag}`
        });
    }
  });

/**
 * Service for compiling and evaluating filter expressions.
 *
 * Provides methods to compile FilterExpr AST into executable predicates,
 * with support for batch evaluation and explanation mode.
 *
 * ## Methods
 *
 * - `evaluate`: Compile a filter into a predicate function
 * - `evaluateWithMetadata`: Like evaluate but returns detailed match results
 * - `evaluateBatch`: Efficiently evaluate a filter against multiple posts
 * - `explain`: Get detailed explanations for why posts match or don't match
 *
 * @example
 * ```ts
 * const runtime = yield* FilterRuntime;
 *
 * // Simple evaluation
 * const predicate = yield* runtime.evaluate(hashtag("tech"));
 * const matches = yield* predicate(post);
 *
 * // Batch evaluation for performance
 * const batchPredicate = yield* runtime.evaluateBatch(filter);
 * const results = yield* batchPredicate(Chunk.fromIterable(posts));
 * ```
 */
export class FilterRuntime extends Context.Tag("@skygent/FilterRuntime")<
  FilterRuntime,
  {
    /**
     * Compiles a filter expression into an executable predicate.
     *
     * @param expr - The filter expression to compile
     * @returns Effect that yields a predicate function
     */
    readonly evaluate: (
      expr: FilterExpr
    ) => Effect.Effect<Predicate, FilterCompileError>;

    /**
     * Like evaluate, but returns detailed match results with metadata.
     *
     * @param expr - The filter expression to compile
     * @returns Effect that yields a predicate returning { ok: boolean }
     */
    readonly evaluateWithMetadata: (
      expr: FilterExpr
    ) => Effect.Effect<
      (post: Post) => Effect.Effect<
        { readonly ok: boolean },
        FilterEvalError
      >,
      FilterCompileError
    >;

    /**
     * Compiles a filter for efficient batch evaluation.
     *
     * Batch evaluation processes multiple posts concurrently with
     * automatic request batching for effectful filters.
     *
     * @param expr - The filter expression to compile
     * @returns Effect that yields a batch predicate
     */
    readonly evaluateBatch: (
      expr: FilterExpr
    ) => Effect.Effect<
      (posts: Chunk.Chunk<Post>) => Effect.Effect<Chunk.Chunk<boolean>, FilterEvalError>,
      FilterCompileError
    >;

    /**
     * Compiles a filter into an explainer function.
     *
     * Explainer functions provide detailed reasoning for filter decisions,
     * useful for debugging and user feedback.
     *
     * @param expr - The filter expression to compile
     * @returns Effect that yields an explainer function
     */
    readonly explain: (
      expr: FilterExpr
    ) => Effect.Effect<Explainer, FilterCompileError>;
  }
>() {
  static readonly layer = Layer.effect(
    FilterRuntime,
    Effect.gen(function* () {
      const links = yield* LinkValidator;
      const trending = yield* TrendingTopics;
      const settings = yield* FilterSettings;
      const evaluate = Effect.fn("FilterRuntime.evaluate")((expr: FilterExpr) =>
        buildPredicate(links, trending)(expr)
      );
      const evaluateWithMetadata = Effect.fn(
        "FilterRuntime.evaluateWithMetadata"
      )((expr: FilterExpr) =>
        buildPredicate(links, trending)(expr).pipe(
          Effect.map((predicate) => (post: Post) =>
            predicate(post).pipe(Effect.map((ok) => ({ ok })))
          )
        )
      );
      const evaluateBatch = Effect.fn("FilterRuntime.evaluateBatch")((expr: FilterExpr) =>
        buildPredicate(links, trending)(expr).pipe(
          Effect.map((predicate) => (posts: Chunk.Chunk<Post>) =>
            Effect.all(Array.from(posts, (post) => predicate(post)), {
              batching: true,
              concurrency: settings.concurrency
            }).pipe(
              Effect.map(Chunk.fromIterable),
              Effect.withRequestBatching(true)
            )
          )
        )
      );
      const explain = Effect.fn("FilterRuntime.explain")((expr: FilterExpr) =>
        buildExplanation(links, trending)(expr)
      );

      return FilterRuntime.of({ evaluate, evaluateWithMetadata, evaluateBatch, explain });
    })
  );
}

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
 * - `HasImages`, `MinImages`, `HasAltText`, `NoAltText`, `AltText`, `AltTextRegex`, `HasVideo`, `HasLinks`, `LinkContains`, `LinkRegex`, `HasMedia`, `HasEmbed`: Media detection
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

import { Chunk, Duration, Effect, Match, Schedule } from "effect";
import { FilterCompileError, FilterEvalError } from "../domain/errors.js";
import type { FilterExpr } from "../domain/filter.js";
import type { FilterErrorPolicy } from "../domain/policies.js";
import type { Post } from "../domain/post.js";
import type { FilterExplanation } from "../domain/filter-explain.js";
import { embedMedia, extractImageRefs, hasExternalEmbed, hasVideoEmbed, isQuoteEmbed } from "../domain/embeds.js";
import { isEmbedExternal, isFeedReasonRepost } from "../domain/bsky.js";
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

const hasExternalLink = (post: Post) =>
  post.links.length > 0 || hasExternalEmbed(post.embed);

const linkUrls = (post: Post): ReadonlyArray<string> => {
  const urls = post.links.map((link) => link.toString());
  if (post.embed && isEmbedExternal(post.embed)) {
    urls.push(post.embed.uri);
  }
  const media = embedMedia(post.embed);
  if (media && isEmbedExternal(media)) {
    urls.push(media.uri);
  }
  return urls;
};

const linkMatches = (post: Post, predicate: (value: string) => boolean) =>
  linkUrls(post).some((value) => predicate(value));

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

const hasVideo = (post: Post) => hasVideoEmbed(post.embed);

const hasMedia = (post: Post) =>
  hasImages(post) || hasVideo(post) || hasExternalLink(post);

const hasEmbed = (post: Post) =>
  post.embed != null || post.recordEmbed != null;

const isRepost = (post: Post) =>
  post.feed?.reason ? isFeedReasonRepost(post.feed.reason) : false;

const isQuote = (post: Post) => isQuoteEmbed(post.embed);

const withPolicy = (
  policy: FilterErrorPolicy,
  effect: Effect.Effect<boolean, FilterEvalError>
): Effect.Effect<boolean, FilterEvalError> => {
  return Match.type<FilterErrorPolicy>().pipe(
    Match.tagsExhaustive({
      Include: () => effect.pipe(Effect.catchAll(() => Effect.succeed(true))),
      Exclude: () => effect.pipe(Effect.catchAll(() => Effect.succeed(false))),
      Retry: (retryPolicy) => {
        if (!Duration.isFinite(retryPolicy.baseDelay)) {
          return Effect.fail(
            FilterEvalError.make({ message: "Retry baseDelay must be finite" })
          );
        }
        const delay = retryPolicy.baseDelay;
        const schedule = Schedule.addDelay(
          Schedule.recurs(retryPolicy.maxRetries),
          () => delay
        );
        return effect.pipe(Effect.retry(schedule));
      }
    })
  )(policy);
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
  return Match.type<FilterErrorPolicy>().pipe(
    Match.tagsExhaustive({
      Include: () =>
        effect.pipe(
          Effect.match({
            onSuccess,
            onFailure: (error) => onError(error, "Include")
          })
        ),
      Exclude: () =>
        effect.pipe(
          Effect.match({
            onSuccess,
            onFailure: (error) => onError(error, "Exclude")
          })
        ),
      Retry: (retryPolicy) => {
        const schedule = retryScheduleFor(retryPolicy);
        if (schedule instanceof FilterEvalError) {
          return Effect.fail(schedule);
        }
        return effect.pipe(Effect.retry(schedule), Effect.map(onSuccess));
      }
    })
  )(policy);
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
    const matchExpr = Match.type<FilterExpr>().pipe(
      Match.withReturnType<Effect.Effect<Explainer, FilterCompileError>>(),
      Match.tagsExhaustive({
        All: () =>
          Effect.succeed((_post: Post) => Effect.succeed({ _tag: "All", ok: true })),
        None: () =>
          Effect.succeed((_post: Post) => Effect.succeed({ _tag: "None", ok: false })),
        Author: (author) =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "Author",
              ok: post.author === author.handle,
              detail: `author=${post.author}, expected=${author.handle}`
            })
          ),
        Hashtag: (hashtag) =>
          Effect.succeed((post: Post) => {
            const matched = post.hashtags.find((tag) => tag === hashtag.tag);
            return Effect.succeed({
              _tag: "Hashtag",
              ok: matched !== undefined,
              detail: matched
                ? `matched=${matched}`
                : `hashtags=${post.hashtags.join(",") || "none"}`
            });
          }),
        AuthorIn: (authorIn) => {
          const handles = new Set(authorIn.handles);
          return Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "AuthorIn",
              ok: handles.has(post.author),
              detail: `author=${post.author}`
            })
          );
        },
        HashtagIn: (hashtagIn) => {
          const tags = new Set(hashtagIn.tags);
          return Effect.succeed((post: Post) => {
            const matched = post.hashtags.find((tag) => tags.has(tag));
            return Effect.succeed({
              _tag: "HashtagIn",
              ok: matched !== undefined,
              detail: matched
                ? `matched=${matched}`
                : `hashtags=${post.hashtags.join(",") || "none"}`
            });
          });
        },
        Contains: (contains) => {
          const needle = contains.caseSensitive ? contains.text : contains.text.toLowerCase();
          return Effect.succeed((post: Post) => {
            const haystack = contains.caseSensitive ? post.text : post.text.toLowerCase();
            const ok = haystack.includes(needle);
            return Effect.succeed({
              _tag: "Contains",
              ok,
              detail: `caseSensitive=${contains.caseSensitive ?? false}`
            });
          });
        },
        IsReply: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "IsReply",
              ok: !!post.reply,
              detail: `reply=${Boolean(post.reply)}`
            })
          ),
        IsQuote: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "IsQuote",
              ok: isQuote(post),
              detail: `quote=${isQuote(post)}`
            })
          ),
        IsRepost: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "IsRepost",
              ok: isRepost(post),
              detail: `repost=${isRepost(post)}`
            })
          ),
        IsOriginal: () =>
          Effect.succeed((post: Post) => {
            const ok = !post.reply && !isQuote(post) && !isRepost(post);
            return Effect.succeed({
              _tag: "IsOriginal",
              ok,
              detail: `reply=${Boolean(post.reply)}, quote=${isQuote(post)}, repost=${isRepost(post)}`
            });
          }),
        Engagement: (engagement) =>
          Effect.succeed((post: Post) => {
            const metrics = post.metrics;
            const likes = metrics?.likeCount ?? 0;
            const reposts = metrics?.repostCount ?? 0;
            const replies = metrics?.replyCount ?? 0;
            const passes = (min: number | undefined, value: number) =>
              min === undefined || value >= min;
            const ok =
              passes(engagement.minLikes, likes) &&
              passes(engagement.minReposts, reposts) &&
              passes(engagement.minReplies, replies);
            return Effect.succeed({
              _tag: "Engagement",
              ok,
              detail: `likes=${likes}, reposts=${reposts}, replies=${replies}`
            });
          }),
        HasImages: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasImages",
              ok: hasImages(post),
              detail: `hasImages=${hasImages(post)}`
            })
          ),
        MinImages: (minImages) =>
          Effect.succeed((post: Post) => {
            const count = imageRefs(post).length;
            const ok = count >= minImages.min;
            return Effect.succeed({
              _tag: "MinImages",
              ok,
              detail: `imageCount=${count}, min=${minImages.min}`
            });
          }),
        HasAltText: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasAltText",
              ok: hasAltText(post),
              detail: `hasAltText=${hasAltText(post)}`
            })
          ),
        NoAltText: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "NoAltText",
              ok: hasMissingAltText(post),
              detail: `missingAltText=${hasMissingAltText(post)}`
            })
          ),
        AltText: (altText) => {
          const needle = altText.text.toLowerCase();
          return Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "AltText",
              ok: altTextMatches(post, (value) => value.toLowerCase().includes(needle)),
              detail: `needle=${altText.text}`
            })
          );
        },
        AltTextRegex: (altText) =>
          Effect.gen(function* () {
            const compiled = yield* Effect.try({
              try: () => new RegExp(altText.pattern, altText.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${altText.pattern}": ${messageFromError(error)}`
                })
            });
            return (post: Post) =>
              Effect.succeed({
                _tag: "AltTextRegex",
                ok: altTextMatches(post, (value) => regexMatches(compiled, value)),
                detail: `pattern=/${altText.pattern}/${altText.flags ?? ""}`
              });
          }),
        HasVideo: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasVideo",
              ok: hasVideo(post),
              detail: `hasVideo=${hasVideo(post)}`
            })
          ),
        HasLinks: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasLinks",
              ok: hasExternalLink(post),
              detail: `links=${post.links.length}`
            })
          ),
        LinkContains: (link) => {
          const needle = link.caseSensitive ? link.text : link.text.toLowerCase();
          const describe = link.caseSensitive
            ? `needle=${link.text}`
            : `needle=${link.text}, caseSensitive=false`;
          return Effect.succeed((post: Post) => {
            const ok = linkMatches(post, (value) =>
              link.caseSensitive
                ? value.includes(needle)
                : value.toLowerCase().includes(needle)
            );
            return Effect.succeed({
              _tag: "LinkContains",
              ok,
              detail: describe
            });
          });
        },
        LinkRegex: (link) =>
          Effect.gen(function* () {
            const compiled = yield* Effect.try({
              try: () => new RegExp(link.pattern, link.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${link.pattern}": ${messageFromError(error)}`
                })
            });
            return (post: Post) =>
              Effect.succeed({
                _tag: "LinkRegex",
                ok: linkMatches(post, (value) => regexMatches(compiled, value)),
                detail: `pattern=/${link.pattern}/${link.flags ?? ""}`
              });
          }),
        HasMedia: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasMedia",
              ok: hasMedia(post),
              detail: `hasMedia=${hasMedia(post)}`
            })
          ),
        HasEmbed: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed({
              _tag: "HasEmbed",
              ok: hasEmbed(post),
              detail: `hasEmbed=${hasEmbed(post)}`
            })
          ),
        Language: (language) => {
          const langs = new Set(language.langs.map((lang) => lang.toLowerCase()));
          return Effect.succeed((post: Post) => {
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
          });
        },
        Regex: (regexExpr) =>
          Effect.gen(function* () {
            if (regexExpr.patterns.length === 0) {
              return yield* FilterCompileError.make({
                message: "Regex patterns must contain at least one entry"
              });
            }
            const compiled = yield* Effect.forEach(
              regexExpr.patterns,
              (pattern) =>
                Effect.try({
                  try: () => new RegExp(pattern, regexExpr.flags),
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
                  : `patterns=${regexExpr.patterns.join(",")}`
              });
            };
          }),
        DateRange: (dateRange) =>
          Effect.succeed((post: Post) => {
            const created = post.createdAt.getTime();
            const ok =
              created >= dateRange.start.getTime() && created <= dateRange.end.getTime();
            return Effect.succeed({
              _tag: "DateRange",
              ok,
              detail: `createdAt=${post.createdAt.toISOString()}`
            });
          }),
        And: (andExpr) =>
          Effect.gen(function* () {
            const left = yield* buildExplanation(links, trending)(andExpr.left);
            const right = yield* buildExplanation(links, trending)(andExpr.right);
            return (post: Post) =>
              left(post).pipe(
                Effect.flatMap((leftResult) => {
                  if (!leftResult.ok) {
                    return Effect.succeed({
                      _tag: "And",
                      ok: false,
                      children: [
                        leftResult,
                        skippedNode(andExpr.right, "Skipped because left side was false.")
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
          }),
        Or: (orExpr) =>
          Effect.gen(function* () {
            const left = yield* buildExplanation(links, trending)(orExpr.left);
            const right = yield* buildExplanation(links, trending)(orExpr.right);
            return (post: Post) =>
              left(post).pipe(
                Effect.flatMap((leftResult) => {
                  if (leftResult.ok) {
                    return Effect.succeed({
                      _tag: "Or",
                      ok: true,
                      children: [
                        leftResult,
                        skippedNode(orExpr.right, "Skipped because left side was true.")
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
          }),
        Not: (notExpr) =>
          Effect.gen(function* () {
            const inner = yield* buildExplanation(links, trending)(notExpr.expr);
            return (post: Post) =>
              inner(post).pipe(
                Effect.map((innerResult) => ({
                  _tag: "Not",
                  ok: !innerResult.ok,
                  children: [innerResult]
                }))
              );
          }),
        HasValidLinks: (hasValidLinks) =>
          Effect.succeed((post: Post) => {
            const urls = post.links.map((link) => link.toString());
            return explainPolicy(
              hasValidLinks.onError,
              links.hasValidLink(urls),
              (ok) => ({
                _tag: "HasValidLinks",
                ok,
                detail: `links=${urls.length}, policy=${hasValidLinks.onError._tag}`
              }),
              (error, policyTag) => ({
                _tag: "HasValidLinks",
                ok: policyTag === "Include",
                detail: `error=${messageFromError(error)}, policy=${policyTag}`
              })
            );
          }),
        Trending: (trendingExpr) =>
          Effect.succeed((_post: Post) =>
            explainPolicy(
              trendingExpr.onError,
              trending.isTrending(trendingExpr.tag),
              (ok) => ({
                _tag: "Trending",
                ok,
                detail: `tag=${trendingExpr.tag}, policy=${trendingExpr.onError._tag}`
              }),
              (error, policyTag) => ({
                _tag: "Trending",
                ok: policyTag === "Include",
                detail: `error=${messageFromError(error)}, policy=${policyTag}`
              })
            )
          )
      })
    );
    return yield* matchExpr(expr);
  });

const buildPredicate = (
  links: LinkValidatorService,
  trending: TrendingTopicsService
): ((expr: FilterExpr) => Effect.Effect<Predicate, FilterCompileError>) =>
  Effect.fn("FilterRuntime.buildPredicate")(function* (expr: FilterExpr) {
    const matchExpr = Match.type<FilterExpr>().pipe(
      Match.withReturnType<Effect.Effect<Predicate, FilterCompileError>>(),
      Match.tagsExhaustive({
        All: () => Effect.succeed((_post: Post) => Effect.succeed(true)),
        None: () => Effect.succeed((_post: Post) => Effect.succeed(false)),
        Author: (author) =>
          Effect.succeed((post: Post) => Effect.succeed(post.author === author.handle)),
        Hashtag: (hashtag) =>
          Effect.succeed((post: Post) =>
            Effect.succeed(post.hashtags.some((tag) => tag === hashtag.tag))
          ),
        AuthorIn: (authorIn) => {
          const handles = new Set(authorIn.handles);
          return Effect.succeed((post: Post) =>
            Effect.succeed(handles.has(post.author))
          );
        },
        HashtagIn: (hashtagIn) => {
          const tags = new Set(hashtagIn.tags);
          return Effect.succeed((post: Post) =>
            Effect.succeed(post.hashtags.some((tag) => tags.has(tag)))
          );
        },
        Contains: (contains) => {
          const needle = contains.caseSensitive ? contains.text : contains.text.toLowerCase();
          return Effect.succeed((post: Post) => {
            const haystack = contains.caseSensitive ? post.text : post.text.toLowerCase();
            return Effect.succeed(haystack.includes(needle));
          });
        },
        IsReply: () => Effect.succeed((post: Post) => Effect.succeed(!!post.reply)),
        IsQuote: () => Effect.succeed((post: Post) => Effect.succeed(isQuote(post))),
        IsRepost: () => Effect.succeed((post: Post) => Effect.succeed(isRepost(post))),
        IsOriginal: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed(!post.reply && !isQuote(post) && !isRepost(post))
          ),
        Engagement: (engagement) =>
          Effect.succeed((post: Post) => {
            const metrics = post.metrics;
            const likes = metrics?.likeCount ?? 0;
            const reposts = metrics?.repostCount ?? 0;
            const replies = metrics?.replyCount ?? 0;
            const passes = (min: number | undefined, value: number) =>
              min === undefined || value >= min;
            return Effect.succeed(
              passes(engagement.minLikes, likes) &&
                passes(engagement.minReposts, reposts) &&
                passes(engagement.minReplies, replies)
            );
          }),
        HasImages: () => Effect.succeed((post: Post) => Effect.succeed(hasImages(post))),
        MinImages: (minImages) =>
          Effect.succeed((post: Post) =>
            Effect.succeed(imageRefs(post).length >= minImages.min)
          ),
        HasAltText: () => Effect.succeed((post: Post) => Effect.succeed(hasAltText(post))),
        NoAltText: () => Effect.succeed((post: Post) => Effect.succeed(hasMissingAltText(post))),
        AltText: (altText) => {
          const needle = altText.text.toLowerCase();
          return Effect.succeed((post: Post) =>
            Effect.succeed(
              altTextMatches(post, (value) => value.toLowerCase().includes(needle))
            )
          );
        },
        AltTextRegex: (altText) =>
          Effect.gen(function* () {
            const compiled = yield* Effect.try({
              try: () => new RegExp(altText.pattern, altText.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${altText.pattern}": ${messageFromError(error)}`
                })
            });
            return (post: Post) =>
              Effect.succeed(
                altTextMatches(post, (value) => regexMatches(compiled, value))
              );
          }),
        HasVideo: () => Effect.succeed((post: Post) => Effect.succeed(hasVideo(post))),
        HasLinks: () =>
          Effect.succeed((post: Post) =>
            Effect.succeed(hasExternalLink(post))
          ),
        LinkContains: (link) => {
          const needle = link.caseSensitive ? link.text : link.text.toLowerCase();
          return Effect.succeed((post: Post) =>
            Effect.succeed(
              linkMatches(post, (value) =>
                link.caseSensitive
                  ? value.includes(needle)
                  : value.toLowerCase().includes(needle)
              )
            )
          );
        },
        LinkRegex: (link) =>
          Effect.gen(function* () {
            const compiled = yield* Effect.try({
              try: () => new RegExp(link.pattern, link.flags),
              catch: (error) =>
                FilterCompileError.make({
                  message: `Invalid regex "${link.pattern}": ${messageFromError(error)}`
                })
            });
            return (post: Post) =>
              Effect.succeed(linkMatches(post, (value) => regexMatches(compiled, value)));
          }),
        HasMedia: () => Effect.succeed((post: Post) => Effect.succeed(hasMedia(post))),
        HasEmbed: () => Effect.succeed((post: Post) => Effect.succeed(hasEmbed(post))),
        Language: (language) => {
          const langs = new Set(language.langs.map((lang) => lang.toLowerCase()));
          return Effect.succeed((post: Post) => {
            if (!post.langs || post.langs.length === 0) {
              return Effect.succeed(false);
            }
            return Effect.succeed(
              post.langs.some((lang) => langs.has(lang.toLowerCase()))
            );
          });
        },
        Regex: (regexExpr) =>
          Effect.gen(function* () {
            if (regexExpr.patterns.length === 0) {
              return yield* FilterCompileError.make({
                message: "Regex patterns must contain at least one entry"
              });
            }
            const compiled = yield* Effect.forEach(
              regexExpr.patterns,
              (pattern) =>
                Effect.try({
                  try: () => new RegExp(pattern, regexExpr.flags),
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
          }),
        DateRange: (dateRange) =>
          Effect.succeed((post: Post) => {
            const created = post.createdAt.getTime();
            return Effect.succeed(
              created >= dateRange.start.getTime() && created <= dateRange.end.getTime()
            );
          }),
        And: (andExpr) =>
          Effect.gen(function* () {
            const left = yield* buildPredicate(links, trending)(andExpr.left);
            const right = yield* buildPredicate(links, trending)(andExpr.right);
            return (post: Post) =>
              left(post).pipe(
                Effect.flatMap((ok) => (ok ? right(post) : Effect.succeed(false)))
              );
          }),
        Or: (orExpr) =>
          Effect.gen(function* () {
            const left = yield* buildPredicate(links, trending)(orExpr.left);
            const right = yield* buildPredicate(links, trending)(orExpr.right);
            return (post: Post) =>
              left(post).pipe(
                Effect.flatMap((ok) => (ok ? Effect.succeed(true) : right(post)))
              );
          }),
        Not: (notExpr) =>
          Effect.gen(function* () {
            const inner = yield* buildPredicate(links, trending)(notExpr.expr);
            return (post: Post) =>
              inner(post).pipe(Effect.map((ok) => !ok));
          }),
        HasValidLinks: (hasValidLinks) =>
          Effect.succeed((post: Post) =>
            withPolicy(
              hasValidLinks.onError,
              links.hasValidLink(post.links.map((link) => link.toString()))
            )
          ),
        Trending: (trendingExpr) =>
          Effect.succeed((_post: Post) =>
            withPolicy(trendingExpr.onError, trending.isTrending(trendingExpr.tag))
          )
      })
    );
    return yield* matchExpr(expr);
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
export class FilterRuntime extends Effect.Service<FilterRuntime>()("@skygent/FilterRuntime", {
  effect: Effect.gen(function* () {
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

    return {
      evaluate,
      evaluateWithMetadata,
      evaluateBatch,
      explain
    };
  })
}) {
  static readonly layer = FilterRuntime.Default;
}

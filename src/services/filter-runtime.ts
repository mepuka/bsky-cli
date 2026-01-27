import { Chunk, Context, Duration, Effect, Layer, Ref, Schedule } from "effect";
import { FilterCompileError, FilterEvalError } from "../domain/errors.js";
import type { FilterExpr } from "../domain/filter.js";
import type { FilterErrorPolicy } from "../domain/policies.js";
import type { Post } from "../domain/post.js";
import type { LlmDecisionMeta } from "../domain/llm.js";
import { LlmDecision, LlmDecisionRequest } from "./llm.js";
import type { LinkValidatorService } from "./link-validator.js";
import type { TrendingTopicsService } from "./trending-topics.js";
import { LinkValidator } from "./link-validator.js";
import { TrendingTopics } from "./trending-topics.js";

type Predicate = (post: Post) => Effect.Effect<boolean, FilterEvalError>;
type LlmRecorder = (meta: LlmDecisionMeta) => Effect.Effect<void>;
type PredicateWithMeta = (
  post: Post,
  record: LlmRecorder
) => Effect.Effect<boolean, FilterEvalError>;
type LlmDecider = {
  readonly decideDetailed: (
    request: LlmDecisionRequest
  ) => Effect.Effect<LlmDecisionMeta, FilterEvalError>;
};

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

const hasImages = (post: Post) => {
  const tag = embedTag(post.embed);
  if (tag === "Images") {
    return true;
  }
  return embedMediaTag(post.embed) === "Images";
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

const buildPredicate = (
  llm: LlmDecider,
  links: LinkValidatorService,
  trending: TrendingTopicsService
): ((expr: FilterExpr) => Effect.Effect<PredicateWithMeta, FilterCompileError>) =>
  Effect.fn("FilterRuntime.buildPredicate")(function* (expr: FilterExpr) {
    switch (expr._tag) {
      case "All":
        return (_post: Post, _record: LlmRecorder) => Effect.succeed(true);
      case "None":
        return (_post: Post, _record: LlmRecorder) => Effect.succeed(false);
      case "Author":
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(post.author === expr.handle);
      case "Hashtag":
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(post.hashtags.some((tag) => tag === expr.tag));
      case "AuthorIn": {
        const handles = new Set(expr.handles);
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(handles.has(post.author));
      }
      case "HashtagIn": {
        const tags = new Set(expr.tags);
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(post.hashtags.some((tag) => tags.has(tag)));
      }
      case "Contains": {
        const needle = expr.caseSensitive ? expr.text : expr.text.toLowerCase();
        return (post: Post, _record: LlmRecorder) => {
          const haystack = expr.caseSensitive ? post.text : post.text.toLowerCase();
          return Effect.succeed(haystack.includes(needle));
        };
      }
      case "IsReply":
        return (post: Post, _record: LlmRecorder) => Effect.succeed(!!post.reply);
      case "IsQuote":
        return (post: Post, _record: LlmRecorder) => Effect.succeed(isQuote(post));
      case "IsRepost":
        return (post: Post, _record: LlmRecorder) => Effect.succeed(isRepost(post));
      case "IsOriginal":
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(!post.reply && !isQuote(post) && !isRepost(post));
      case "Engagement":
        return (post: Post, _record: LlmRecorder) => {
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
        return (post: Post, _record: LlmRecorder) => Effect.succeed(hasImages(post));
      case "HasVideo":
        return (post: Post, _record: LlmRecorder) => Effect.succeed(hasVideo(post));
      case "HasLinks":
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(hasExternalLink(post));
      case "HasMedia":
        return (post: Post, _record: LlmRecorder) => Effect.succeed(hasMedia(post));
      case "Language": {
        const langs = new Set(expr.langs.map((lang) => lang.toLowerCase()));
        return (post: Post, _record: LlmRecorder) => {
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
        return (post: Post, _record: LlmRecorder) =>
          Effect.succeed(
            compiled.some((regex) => {
              if (regex.global || regex.sticky) {
                regex.lastIndex = 0;
              }
              return regex.test(post.text);
            })
          );
      }
      case "DateRange":
        return (post: Post, _record: LlmRecorder) => {
          const created = post.createdAt.getTime();
          return Effect.succeed(
            created >= expr.start.getTime() && created <= expr.end.getTime()
          );
        };
      case "And": {
        const left = yield* buildPredicate(llm, links, trending)(expr.left);
        const right = yield* buildPredicate(llm, links, trending)(expr.right);
        return (post: Post, record: LlmRecorder) =>
          left(post, record).pipe(
            Effect.flatMap((ok) =>
              ok ? right(post, record) : Effect.succeed(false)
            )
          );
      }
      case "Or": {
        const left = yield* buildPredicate(llm, links, trending)(expr.left);
        const right = yield* buildPredicate(llm, links, trending)(expr.right);
        return (post: Post, record: LlmRecorder) =>
          left(post, record).pipe(
            Effect.flatMap((ok) =>
              ok ? Effect.succeed(true) : right(post, record)
            )
          );
      }
      case "Not": {
        const inner = yield* buildPredicate(llm, links, trending)(expr.expr);
        return (post: Post, record: LlmRecorder) =>
          inner(post, record).pipe(Effect.map((ok) => !ok));
      }
      case "HasValidLinks": {
        return (post: Post, _record: LlmRecorder) =>
          withPolicy(
            expr.onError,
            links.hasValidLink(post.links.map((link) => link.toString()))
          );
      }
      case "Trending": {
        return (_post: Post, _record: LlmRecorder) =>
          withPolicy(expr.onError, trending.isTrending(expr.tag));
      }
      case "Llm": {
        return (post: Post, record: LlmRecorder) =>
          withPolicy(
            expr.onError,
            llm
              .decideDetailed(
                new LlmDecisionRequest({
                  prompt: expr.prompt,
                  text: post.text,
                  minConfidence: expr.minConfidence
                })
              )
              .pipe(
                Effect.tap(record),
                Effect.map((meta) => meta.keep)
              )
          );
      }
      default:
        return yield* FilterCompileError.make({
          message: `Unknown filter tag: ${(expr as { _tag: string })._tag}`
        });
    }
  });

export class FilterRuntime extends Context.Tag("@skygent/FilterRuntime")<
  FilterRuntime,
  {
    readonly evaluate: (
      expr: FilterExpr
    ) => Effect.Effect<Predicate, FilterCompileError>;
    readonly evaluateWithMetadata: (
      expr: FilterExpr
    ) => Effect.Effect<
      (post: Post) => Effect.Effect<
        { readonly ok: boolean; readonly llm: ReadonlyArray<LlmDecisionMeta> },
        FilterEvalError
      >,
      FilterCompileError
    >;
    readonly evaluateBatch: (
      expr: FilterExpr
    ) => Effect.Effect<
      (posts: Chunk.Chunk<Post>) => Effect.Effect<Chunk.Chunk<boolean>, FilterEvalError>,
      FilterCompileError
    >;
  }
>() {
  static readonly layer = Layer.effect(
    FilterRuntime,
    Effect.gen(function* () {
      const llm = yield* LlmDecision;
      const links = yield* LinkValidator;
      const trending = yield* TrendingTopics;
      const noopRecord: LlmRecorder = () => Effect.void;
      const evaluate = Effect.fn("FilterRuntime.evaluate")((expr: FilterExpr) =>
        buildPredicate(llm, links, trending)(expr).pipe(
          Effect.map((predicate) => (post: Post) => predicate(post, noopRecord))
        )
      );
      const evaluateWithMetadata = Effect.fn(
        "FilterRuntime.evaluateWithMetadata"
      )((expr: FilterExpr) =>
        buildPredicate(llm, links, trending)(expr).pipe(
          Effect.map((predicate) => (post: Post) =>
            Effect.gen(function* () {
              const ref = yield* Ref.make<ReadonlyArray<LlmDecisionMeta>>([]);
              const record: LlmRecorder = (meta) =>
                Ref.update(ref, (items) => [...items, meta]);
              const ok = yield* predicate(post, record);
              const llm = yield* Ref.get(ref);
              return { ok, llm };
            })
          )
        )
      );
      const evaluateBatch = Effect.fn("FilterRuntime.evaluateBatch")((expr: FilterExpr) =>
        buildPredicate(llm, links, trending)(expr).pipe(
          Effect.map((predicate) => (posts: Chunk.Chunk<Post>) =>
            Effect.all(Array.from(posts, (post) => predicate(post, noopRecord)), {
              batching: true,
              concurrency: "unbounded"
            }).pipe(
              Effect.map(Chunk.fromIterable),
              Effect.withRequestBatching(true)
            )
          )
        )
      );

      return FilterRuntime.of({ evaluate, evaluateWithMetadata, evaluateBatch });
    })
  );
}

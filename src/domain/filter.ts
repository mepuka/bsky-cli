import { Schema } from "effect";
import * as Monoid from "@effect/typeclass/Monoid";
import * as Semigroup from "@effect/typeclass/Semigroup";
import { Handle, Hashtag, Timestamp } from "./primitives.js";
import { FilterErrorPolicy } from "./policies.js";

const required = <A, I, R>(schema: Schema.Schema<A, I, R>, message: string) =>
  Schema.propertySignature(schema).annotations({
    missingMessage: () => message
  });

/**
 * Filter that matches all posts.
 *
 * Used as an identity element for filter composition.
 */
export interface FilterAll {
  readonly _tag: "All";
}

/**
 * Filter that matches no posts.
 *
 * Used to exclude everything in filter composition.
 */
export interface FilterNone {
  readonly _tag: "None";
}

/**
 * Logical AND composition of two filters.
 *
 * A post matches if both left and right filters match.
 *
 * @example
 * ```ts
 * and(author("@alice.bsky.social"), hashtag("tech"))
 * // Matches posts by @alice.bsky.social containing #tech
 * ```
 */
export interface FilterAnd {
  readonly _tag: "And";
  /** The left filter expression */
  readonly left: FilterExpr;
  /** The right filter expression */
  readonly right: FilterExpr;
}

/**
 * Logical OR composition of two filters.
 *
 * A post matches if either left or right filter matches.
 *
 * @example
 * ```ts
 * or(hashtag("javascript"), hashtag("typescript"))
 * // Matches posts with either #javascript or #typescript
 * ```
 */
export interface FilterOr {
  readonly _tag: "Or";
  /** The left filter expression */
  readonly left: FilterExpr;
  /** The right filter expression */
  readonly right: FilterExpr;
}

/**
 * Logical NOT of a filter.
 *
 * A post matches if the wrapped filter does NOT match.
 *
 * @example
 * ```ts
 * not(isReply())
 * // Matches posts that are NOT replies
 * ```
 */
export interface FilterNot {
  readonly _tag: "Not";
  /** The filter expression to negate */
  readonly expr: FilterExpr;
}

/**
 * Filter posts by a specific author handle.
 *
 * @example
 * ```ts
 * author("@alice.bsky.social")
 * // Matches all posts by @alice.bsky.social
 * ```
 */
export interface FilterAuthor {
  readonly _tag: "Author";
  /** The author's handle (with or without @ prefix) */
  readonly handle: Handle;
}

/**
 * Filter posts containing a specific hashtag.
 *
 * @example
 * ```ts
 * hashtag("tech")
 * // Matches posts containing #tech
 * ```
 */
export interface FilterHashtag {
  readonly _tag: "Hashtag";
  /** The hashtag to match (without # prefix) */
  readonly tag: Hashtag;
}

/**
 * Filter posts by multiple author handles (matches any).
 *
 * @example
 * ```ts
 * authorIn(["@alice.bsky.social", "@bob.bsky.social"])
 * // Matches posts by either @alice.bsky.social or @bob.bsky.social
 * ```
 */
export interface FilterAuthorIn {
  readonly _tag: "AuthorIn";
  /** Array of author handles to match */
  readonly handles: ReadonlyArray<Handle>;
}

/**
 * Filter posts containing any of multiple hashtags.
 *
 * @example
 * ```ts
 * hashtagIn(["javascript", "typescript", "nodejs"])
 * // Matches posts with any of the specified hashtags
 * ```
 */
export interface FilterHashtagIn {
  readonly _tag: "HashtagIn";
  /** Array of hashtags to match (without # prefix) */
  readonly tags: ReadonlyArray<Hashtag>;
}

/**
 * Filter posts containing specific text.
 *
 * Performs substring matching on the post text.
 *
 * @example
 * ```ts
 * contains("skygent", { caseSensitive: false })
 * // Matches posts containing "skygent", "SkyGent", etc.
 * ```
 */
export interface FilterContains {
  readonly _tag: "Contains";
  /** The text to search for */
  readonly text: string;
  /** Whether matching should be case-sensitive (default: false) */
  readonly caseSensitive?: boolean;
}

/**
 * Filter posts that are replies to other posts.
 */
export interface FilterIsReply {
  readonly _tag: "IsReply";
}

/**
 * Filter posts that quote other posts.
 */
export interface FilterIsQuote {
  readonly _tag: "IsQuote";
}

/**
 * Filter posts that are reposts.
 */
export interface FilterIsRepost {
  readonly _tag: "IsRepost";
}

/**
 * Filter posts that are original content (not reposts).
 */
export interface FilterIsOriginal {
  readonly _tag: "IsOriginal";
}

/**
 * Filter posts by engagement metrics (likes, reposts, replies).
 *
 * Requires at least one threshold to be specified.
 *
 * @example
 * ```ts
 * engagement({ minLikes: 10, minReposts: 5 })
 * // Matches posts with at least 10 likes AND 5 reposts
 * ```
 */
export interface FilterEngagement {
  readonly _tag: "Engagement";
  /** Minimum number of likes required */
  readonly minLikes?: number;
  /** Minimum number of reposts required */
  readonly minReposts?: number;
  /** Minimum number of replies required */
  readonly minReplies?: number;
}

/**
 * Filter posts containing images.
 */
export interface FilterHasImages {
  readonly _tag: "HasImages";
}

/**
 * Filter posts with at least N images.
 */
export interface FilterMinImages {
  readonly _tag: "MinImages";
  readonly min: number;
}

/**
 * Filter posts where every image has alt text.
 */
export interface FilterHasAltText {
  readonly _tag: "HasAltText";
}

/**
 * Filter posts that include images missing alt text.
 */
export interface FilterNoAltText {
  readonly _tag: "NoAltText";
}

/**
 * Filter posts with alt text matching a substring (case-insensitive).
 */
export interface FilterAltText {
  readonly _tag: "AltText";
  readonly text: string;
}

/**
 * Filter posts with alt text matching a regex pattern.
 */
export interface FilterAltTextRegex {
  readonly _tag: "AltTextRegex";
  readonly pattern: string;
  readonly flags?: string;
}

/**
 * Filter posts containing video.
 */
export interface FilterHasVideo {
  readonly _tag: "HasVideo";
}

/**
 * Filter posts containing external links.
 */
export interface FilterHasLinks {
  readonly _tag: "HasLinks";
}

/**
 * Filter posts containing any media (images, video, or external links).
 */
export interface FilterHasMedia {
  readonly _tag: "HasMedia";
}

/**
 * Filter posts containing any embed (media, records, or external links).
 */
export interface FilterHasEmbed {
  readonly _tag: "HasEmbed";
}

/**
 * Filter posts by language codes.
 *
 * Matches posts that have any of the specified languages in their `langs` field.
 *
 * @example
 * ```ts
 * language(["en", "es"])
 * // Matches posts marked as English or Spanish
 * ```
 */
export interface FilterLanguage {
  readonly _tag: "Language";
  /** Array of ISO 639-1 language codes */
  readonly langs: ReadonlyArray<string>;
}

/**
 * Filter posts using regular expression patterns.
 *
 * @example
 * ```ts
 * regex(["\\bnodejs\\b", "\\bnode\\.js\\b"], "i")
 * // Matches posts containing "nodejs" or "node.js" (case-insensitive)
 * ```
 */
export interface FilterRegex {
  readonly _tag: "Regex";
  /** One or more regex patterns to match */
  readonly patterns: ReadonlyArray<string>;
  /** Regex flags (e.g., "i" for case-insensitive, "g" for global) */
  readonly flags?: string;
}

/**
 * Filter posts by creation date range.
 *
 * @example
 * ```ts
 * dateRange("2024-01-01", "2024-12-31")
 * // Matches posts created in 2024
 * ```
 */
export interface FilterDateRange {
  readonly _tag: "DateRange";
  /** Start of the date range (inclusive) */
  readonly start: Timestamp;
  /** End of the date range (inclusive) */
  readonly end: Timestamp;
}

/**
 * Filter posts that have valid external links.
 *
 * This is an effectful filter that may perform HTTP requests to validate links.
 *
 * @example
 * ```ts
 * hasValidLinks({ onError: { _tag: "Exclude" } })
 * // Matches posts where all external links are valid (404s are excluded)
 * ```
 */
export interface FilterHasValidLinks {
  readonly _tag: "HasValidLinks";
  /** Policy for handling validation errors */
  readonly onError: FilterErrorPolicy;
}

/**
 * Filter for posts about trending topics.
 *
 * This is an effectful filter that checks hashtag trending status.
 *
 * @example
 * ```ts
 * trending("tech", { onError: { _tag: "Include" } })
 * // Matches posts with #tech when it's trending
 * ```
 */
export interface FilterTrending {
  readonly _tag: "Trending";
  /** The hashtag to check for trending status */
  readonly tag: Hashtag;
  /** Policy for handling errors (e.g., API failures) */
  readonly onError: FilterErrorPolicy;
}

/**
 * The complete set of filter expressions supported by Skygent.
 *
 * Filter expressions can be combined using `and`, `or`, and `not` to create
 * complex filtering logic. They are used to determine which posts should be
 * stored, output, or displayed.
 *
 * @example
 * ```ts
 * and(
 *   hashtag("tech"),
 *   or(
 *     author("@alice.bsky.social"),
 *     engagement({ minLikes: 100 })
 *   ),
 *   not(isReply())
 * )
 * // Matches tech posts by @alice.bsky.social OR tech posts with 100+ likes,
 * // excluding replies
 * ```
 */
export type FilterExpr =
  | FilterAll
  | FilterNone
  | FilterAnd
  | FilterOr
  | FilterNot
  | FilterAuthor
  | FilterHashtag
  | FilterAuthorIn
  | FilterHashtagIn
  | FilterContains
  | FilterIsReply
  | FilterIsQuote
  | FilterIsRepost
  | FilterIsOriginal
  | FilterEngagement
  | FilterHasImages
  | FilterMinImages
  | FilterHasAltText
  | FilterNoAltText
  | FilterAltText
  | FilterAltTextRegex
  | FilterHasVideo
  | FilterHasLinks
  | FilterHasMedia
  | FilterHasEmbed
  | FilterLanguage
  | FilterRegex
  | FilterDateRange
  | FilterHasValidLinks
  | FilterTrending;

interface FilterAllEncoded {
  readonly _tag: "All";
}
interface FilterNoneEncoded {
  readonly _tag: "None";
}
interface FilterAndEncoded {
  readonly _tag: "And";
  readonly left: FilterExprEncoded;
  readonly right: FilterExprEncoded;
}
interface FilterOrEncoded {
  readonly _tag: "Or";
  readonly left: FilterExprEncoded;
  readonly right: FilterExprEncoded;
}
interface FilterNotEncoded {
  readonly _tag: "Not";
  readonly expr: FilterExprEncoded;
}
interface FilterAuthorEncoded {
  readonly _tag: "Author";
  readonly handle: string;
}
interface FilterHashtagEncoded {
  readonly _tag: "Hashtag";
  readonly tag: string;
}
interface FilterAuthorInEncoded {
  readonly _tag: "AuthorIn";
  readonly handles: ReadonlyArray<string>;
}
interface FilterHashtagInEncoded {
  readonly _tag: "HashtagIn";
  readonly tags: ReadonlyArray<string>;
}
interface FilterContainsEncoded {
  readonly _tag: "Contains";
  readonly text: string;
  readonly caseSensitive?: boolean;
}
interface FilterIsReplyEncoded {
  readonly _tag: "IsReply";
}
interface FilterIsQuoteEncoded {
  readonly _tag: "IsQuote";
}
interface FilterIsRepostEncoded {
  readonly _tag: "IsRepost";
}
interface FilterIsOriginalEncoded {
  readonly _tag: "IsOriginal";
}
interface FilterEngagementEncoded {
  readonly _tag: "Engagement";
  readonly minLikes?: number;
  readonly minReposts?: number;
  readonly minReplies?: number;
}
interface FilterHasImagesEncoded {
  readonly _tag: "HasImages";
}
interface FilterMinImagesEncoded {
  readonly _tag: "MinImages";
  readonly min: number;
}
interface FilterHasAltTextEncoded {
  readonly _tag: "HasAltText";
}
interface FilterNoAltTextEncoded {
  readonly _tag: "NoAltText";
}
interface FilterAltTextEncoded {
  readonly _tag: "AltText";
  readonly text: string;
}
interface FilterAltTextRegexEncoded {
  readonly _tag: "AltTextRegex";
  readonly pattern: string;
  readonly flags?: string;
}
interface FilterHasVideoEncoded {
  readonly _tag: "HasVideo";
}
interface FilterHasLinksEncoded {
  readonly _tag: "HasLinks";
}
interface FilterHasMediaEncoded {
  readonly _tag: "HasMedia";
}
interface FilterHasEmbedEncoded {
  readonly _tag: "HasEmbed";
}
interface FilterLanguageEncoded {
  readonly _tag: "Language";
  readonly langs: ReadonlyArray<string>;
}
type RegexPatternsEncoded = string | ReadonlyArray<string>;
interface FilterRegexEncoded {
  readonly _tag: "Regex";
  readonly patterns: RegexPatternsEncoded;
  readonly flags?: string;
}
interface FilterDateRangeEncoded {
  readonly _tag: "DateRange";
  readonly start: string | Date;
  readonly end: string | Date;
}
type FilterErrorPolicyEncoded = typeof FilterErrorPolicy.Encoded;
interface FilterHasValidLinksEncoded {
  readonly _tag: "HasValidLinks";
  readonly onError: FilterErrorPolicyEncoded;
}
interface FilterTrendingEncoded {
  readonly _tag: "Trending";
  readonly tag: string;
  readonly onError: FilterErrorPolicyEncoded;
}
type FilterExprEncoded =
  | FilterAllEncoded
  | FilterNoneEncoded
  | FilterAndEncoded
  | FilterOrEncoded
  | FilterNotEncoded
  | FilterAuthorEncoded
  | FilterHashtagEncoded
  | FilterAuthorInEncoded
  | FilterHashtagInEncoded
  | FilterContainsEncoded
  | FilterIsReplyEncoded
  | FilterIsQuoteEncoded
  | FilterIsRepostEncoded
  | FilterIsOriginalEncoded
  | FilterEngagementEncoded
  | FilterHasImagesEncoded
  | FilterMinImagesEncoded
  | FilterHasAltTextEncoded
  | FilterNoAltTextEncoded
  | FilterAltTextEncoded
  | FilterAltTextRegexEncoded
  | FilterHasVideoEncoded
  | FilterHasLinksEncoded
  | FilterHasMediaEncoded
  | FilterHasEmbedEncoded
  | FilterLanguageEncoded
  | FilterRegexEncoded
  | FilterDateRangeEncoded
  | FilterHasValidLinksEncoded
  | FilterTrendingEncoded;

/** JSON schema for serializing/deserializing filter expressions. */
export const FilterExprSchema: Schema.Schema<FilterExpr, FilterExprEncoded, never> = Schema.suspend(
  () => FilterExprInternal
);

const FilterAllSchema: Schema.Schema<FilterAll, FilterAllEncoded, never> = Schema.TaggedStruct(
  "All",
  {}
);
const FilterNoneSchema: Schema.Schema<FilterNone, FilterNoneEncoded, never> = Schema.TaggedStruct(
  "None",
  {}
);
const FilterAndSchema: Schema.Schema<FilterAnd, FilterAndEncoded, never> = Schema.TaggedStruct("And", {
  left: required(FilterExprSchema, "\"left\" is required"),
  right: required(FilterExprSchema, "\"right\" is required")
});
const FilterOrSchema: Schema.Schema<FilterOr, FilterOrEncoded, never> = Schema.TaggedStruct("Or", {
  left: required(FilterExprSchema, "\"left\" is required"),
  right: required(FilterExprSchema, "\"right\" is required")
});
const FilterNotSchema: Schema.Schema<FilterNot, FilterNotEncoded, never> = Schema.TaggedStruct("Not", {
  expr: required(FilterExprSchema, "\"expr\" is required")
});
const FilterAuthorSchema: Schema.Schema<FilterAuthor, FilterAuthorEncoded, never> = Schema.TaggedStruct(
  "Author",
  { handle: required(Handle, "\"handle\" is required") }
);
const FilterHashtagSchema: Schema.Schema<FilterHashtag, FilterHashtagEncoded, never> = Schema.TaggedStruct(
  "Hashtag",
  { tag: required(Hashtag, "\"tag\" is required") }
);
const HandleList = Schema.Array(Handle).pipe(Schema.minItems(1));
const HashtagList = Schema.Array(Hashtag).pipe(Schema.minItems(1));
const FilterAuthorInSchema: Schema.Schema<FilterAuthorIn, FilterAuthorInEncoded, never> = Schema.TaggedStruct(
  "AuthorIn",
  { handles: required(HandleList, "\"handles\" is required") }
);
const FilterHashtagInSchema: Schema.Schema<FilterHashtagIn, FilterHashtagInEncoded, never> = Schema.TaggedStruct(
  "HashtagIn",
  { tags: required(HashtagList, "\"tags\" is required") }
);
const FilterContainsSchema: Schema.Schema<FilterContains, FilterContainsEncoded, never> = Schema.TaggedStruct(
  "Contains",
  {
    text: required(Schema.NonEmptyString, "\"text\" is required"),
    caseSensitive: Schema.optionalWith(Schema.Boolean, { exact: true })
  }
);
const FilterIsReplySchema: Schema.Schema<FilterIsReply, FilterIsReplyEncoded, never> = Schema.TaggedStruct(
  "IsReply",
  {}
);
const FilterIsQuoteSchema: Schema.Schema<FilterIsQuote, FilterIsQuoteEncoded, never> = Schema.TaggedStruct(
  "IsQuote",
  {}
);
const FilterIsRepostSchema: Schema.Schema<FilterIsRepost, FilterIsRepostEncoded, never> = Schema.TaggedStruct(
  "IsRepost",
  {}
);
const FilterIsOriginalSchema: Schema.Schema<FilterIsOriginal, FilterIsOriginalEncoded, never> =
  Schema.TaggedStruct("IsOriginal", {});
const EngagementThreshold = Schema.NonNegativeInt;
const FilterEngagementSchema: Schema.Schema<FilterEngagement, FilterEngagementEncoded, never> =
  Schema.TaggedStruct("Engagement", {
    minLikes: Schema.optionalWith(EngagementThreshold, { exact: true }),
    minReposts: Schema.optionalWith(EngagementThreshold, { exact: true }),
    minReplies: Schema.optionalWith(EngagementThreshold, { exact: true })
  }).pipe(
    Schema.filter((e) =>
      e.minLikes !== undefined || e.minReposts !== undefined || e.minReplies !== undefined
        ? undefined
        : "Engagement filter requires at least one threshold (minLikes, minReposts, or minReplies)"
    )
  ) as any;
const FilterHasImagesSchema: Schema.Schema<FilterHasImages, FilterHasImagesEncoded, never> =
  Schema.TaggedStruct("HasImages", {});
const MinImagesCount = Schema.NonNegativeInt.pipe(
  Schema.filter((value) => value > 0 ? undefined : "MinImages requires min >= 1")
);
const FilterMinImagesSchema: Schema.Schema<FilterMinImages, FilterMinImagesEncoded, never> =
  Schema.TaggedStruct("MinImages", {
    min: required(MinImagesCount, "\"min\" is required")
  });
const FilterHasAltTextSchema: Schema.Schema<FilterHasAltText, FilterHasAltTextEncoded, never> =
  Schema.TaggedStruct("HasAltText", {});
const FilterNoAltTextSchema: Schema.Schema<FilterNoAltText, FilterNoAltTextEncoded, never> =
  Schema.TaggedStruct("NoAltText", {});
const AltTextPattern = Schema.NonEmptyString;
const FilterAltTextSchema: Schema.Schema<FilterAltText, FilterAltTextEncoded, never> =
  Schema.TaggedStruct("AltText", {
    text: required(AltTextPattern, "\"text\" is required")
  });
const FilterAltTextRegexSchema: Schema.Schema<FilterAltTextRegex, FilterAltTextRegexEncoded, never> =
  Schema.TaggedStruct("AltTextRegex", {
    pattern: required(AltTextPattern, "\"pattern\" is required"),
    flags: Schema.optionalWith(Schema.String, { exact: true })
  });
const FilterHasVideoSchema: Schema.Schema<FilterHasVideo, FilterHasVideoEncoded, never> = Schema.TaggedStruct(
  "HasVideo",
  {}
);
const FilterHasLinksSchema: Schema.Schema<FilterHasLinks, FilterHasLinksEncoded, never> = Schema.TaggedStruct(
  "HasLinks",
  {}
);
const FilterHasMediaSchema: Schema.Schema<FilterHasMedia, FilterHasMediaEncoded, never> = Schema.TaggedStruct(
  "HasMedia",
  {}
);
const FilterHasEmbedSchema: Schema.Schema<FilterHasEmbed, FilterHasEmbedEncoded, never> = Schema.TaggedStruct(
  "HasEmbed",
  {}
);
const LanguageList = Schema.Array(Schema.NonEmptyString).pipe(Schema.minItems(1));
const FilterLanguageSchema: Schema.Schema<FilterLanguage, FilterLanguageEncoded, never> = Schema.TaggedStruct(
  "Language",
  { langs: required(LanguageList, "\"langs\" is required") }
);
const RegexPattern = Schema.NonEmptyString;
const RegexPatternList = Schema.Array(RegexPattern).pipe(Schema.minItems(1));
const RegexPatternsSchema: Schema.Schema<
  ReadonlyArray<string>,
  RegexPatternsEncoded,
  never
> = Schema.transform(
  Schema.Union(RegexPattern, RegexPatternList),
  RegexPatternList,
  {
    strict: true,
    decode: (input, _fromInput) =>
      Array.isArray(input) ? input : [input],
    encode: (_patternsInput, patterns) =>
      patterns.length === 1 ? patterns[0]! : patterns
  }
);
const FilterRegexSchema: Schema.Schema<FilterRegex, FilterRegexEncoded, never> = Schema.TaggedStruct(
  "Regex",
  {
    patterns: required(RegexPatternsSchema, "\"patterns\" is required"),
    flags: Schema.optionalWith(Schema.String, { exact: true })
  }
);
const FilterDateRangeSchema: Schema.Schema<
  FilterDateRange,
  FilterDateRangeEncoded,
  never
> = Schema.TaggedStruct("DateRange", {
  start: required(Timestamp, "\"start\" is required"),
  end: required(Timestamp, "\"end\" is required")
}).pipe(
  Schema.filter((dr) =>
    dr.start.getTime() < dr.end.getTime()
      ? undefined
      : "\"start\" must be before \"end\""
  )
) as any;
const FilterHasValidLinksSchema: Schema.Schema<
  FilterHasValidLinks,
  FilterHasValidLinksEncoded,
  never
> = Schema.TaggedStruct("HasValidLinks", {
  onError: required(FilterErrorPolicy, "\"onError\" is required")
});
const FilterTrendingSchema: Schema.Schema<FilterTrending, FilterTrendingEncoded, never> = Schema.TaggedStruct(
  "Trending",
  {
    tag: required(Hashtag, "\"tag\" is required"),
    onError: required(FilterErrorPolicy, "\"onError\" is required")
  }
);
const FilterExprInternal: Schema.Schema<FilterExpr, FilterExprEncoded, never> = Schema.Union(
  FilterAllSchema,
  FilterNoneSchema,
  FilterAndSchema,
  FilterOrSchema,
  FilterNotSchema,
  FilterAuthorSchema,
  FilterHashtagSchema,
  FilterAuthorInSchema,
  FilterHashtagInSchema,
  FilterContainsSchema,
  FilterIsReplySchema,
  FilterIsQuoteSchema,
  FilterIsRepostSchema,
  FilterIsOriginalSchema,
  FilterEngagementSchema,
  FilterHasImagesSchema,
  FilterMinImagesSchema,
  FilterHasAltTextSchema,
  FilterNoAltTextSchema,
  FilterAltTextSchema,
  FilterAltTextRegexSchema,
  FilterHasVideoSchema,
  FilterHasLinksSchema,
  FilterHasMediaSchema,
  FilterHasEmbedSchema,
  FilterLanguageSchema,
  FilterRegexSchema,
  FilterDateRangeSchema,
  FilterHasValidLinksSchema,
  FilterTrendingSchema
).annotations({ identifier: "FilterExpr" });

/** Creates a filter that matches all posts. */
export const all = (): FilterAll => ({ _tag: "All" });

/** Creates a filter that matches no posts. */
export const none = (): FilterNone => ({ _tag: "None" });

/**
 * Creates an AND filter combining two expressions.
 * @param left - First filter expression
 * @param right - Second filter expression
 * @returns A filter that matches when both expressions match
 */
export const and = (left: FilterExpr, right: FilterExpr): FilterAnd => ({
  _tag: "And",
  left,
  right
});

/**
 * Creates an OR filter combining two expressions.
 * @param left - First filter expression
 * @param right - Second filter expression
 * @returns A filter that matches when either expression matches
 */
export const or = (left: FilterExpr, right: FilterExpr): FilterOr => ({
  _tag: "Or",
  left,
  right
});

/**
 * Creates a NOT filter that negates an expression.
 * @param expr - The filter expression to negate
 * @returns A filter that matches when the expression does NOT match
 */
export const not = (expr: FilterExpr): FilterNot => ({ _tag: "Not", expr });

/**
 * Semigroup for combining filters using logical AND.
 *
 * Enables combining multiple filters: `filters.reduce(FilterExprSemigroup.combine)`
 */
export const FilterExprSemigroup: Semigroup.Semigroup<FilterExpr> = Semigroup.make(
  (left, right) => and(left, right)
);

/**
 * Monoid for filters with `all()` as the identity element.
 *
 * Provides `combine` (AND) and `empty` (match all) operations.
 */
export const FilterExprMonoid: Monoid.Monoid<FilterExpr> = Monoid.fromSemigroup(
  FilterExprSemigroup,
  all()
);

/**
 * Encodes a filter expression to its JSON-serializable form.
 *
 * @param expr - The filter expression to encode
 * @returns The encoded filter expression
 */
export const encodeFilterExpr = (expr: FilterExpr): FilterExprEncoded =>
  Schema.encodeSync(FilterExprSchema)(expr);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const entries = sorted.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(",")}}`;
};

/**
 * Generates a canonical signature for a filter expression.
 *
 * This produces a consistent string representation that can be used for
 * caching, comparison, or generating stable identifiers.
 *
 * @param expr - The filter expression
 * @returns A canonical JSON string representation
 */
export const filterExprSignature = (expr: FilterExpr): string =>
  canonicalJson(encodeFilterExpr(expr));

/**
 * Checks if a filter expression requires effects to evaluate.
 *
 * Effectful filters (like `HasValidLinks` and `Trending`) may perform
 * async operations like HTTP requests and need special handling.
 *
 * @param expr - The filter expression to check
 * @returns True if the filter requires effects to evaluate
 */
export const isEffectfulFilter = (expr: FilterExpr): boolean => {
  switch (expr._tag) {
    case "HasValidLinks":
    case "Trending":
      return true;
    case "And":
    case "Or":
      return isEffectfulFilter(expr.left) || isEffectfulFilter(expr.right);
    case "Not":
      return isEffectfulFilter(expr.expr);
    default:
      return false;
  }
};

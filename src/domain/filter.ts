import { Schema } from "effect";
import * as Monoid from "@effect/typeclass/Monoid";
import * as Semigroup from "@effect/typeclass/Semigroup";
import { Handle, Hashtag, Timestamp } from "./primitives.js";
import { FilterErrorPolicy } from "./policies.js";

const required = <A, I, R>(schema: Schema.Schema<A, I, R>, message: string) =>
  Schema.propertySignature(schema).annotations({
    missingMessage: () => message
  });

export interface FilterAll {
  readonly _tag: "All";
}
export interface FilterNone {
  readonly _tag: "None";
}
export interface FilterAnd {
  readonly _tag: "And";
  readonly left: FilterExpr;
  readonly right: FilterExpr;
}
export interface FilterOr {
  readonly _tag: "Or";
  readonly left: FilterExpr;
  readonly right: FilterExpr;
}
export interface FilterNot {
  readonly _tag: "Not";
  readonly expr: FilterExpr;
}
export interface FilterAuthor {
  readonly _tag: "Author";
  readonly handle: Handle;
}
export interface FilterHashtag {
  readonly _tag: "Hashtag";
  readonly tag: Hashtag;
}
export interface FilterAuthorIn {
  readonly _tag: "AuthorIn";
  readonly handles: ReadonlyArray<Handle>;
}
export interface FilterHashtagIn {
  readonly _tag: "HashtagIn";
  readonly tags: ReadonlyArray<Hashtag>;
}
export interface FilterContains {
  readonly _tag: "Contains";
  readonly text: string;
  readonly caseSensitive?: boolean;
}
export interface FilterIsReply {
  readonly _tag: "IsReply";
}
export interface FilterIsQuote {
  readonly _tag: "IsQuote";
}
export interface FilterIsRepost {
  readonly _tag: "IsRepost";
}
export interface FilterIsOriginal {
  readonly _tag: "IsOriginal";
}
export interface FilterEngagement {
  readonly _tag: "Engagement";
  readonly minLikes?: number;
  readonly minReposts?: number;
  readonly minReplies?: number;
}
export interface FilterHasImages {
  readonly _tag: "HasImages";
}
export interface FilterHasVideo {
  readonly _tag: "HasVideo";
}
export interface FilterHasLinks {
  readonly _tag: "HasLinks";
}
export interface FilterHasMedia {
  readonly _tag: "HasMedia";
}
export interface FilterLanguage {
  readonly _tag: "Language";
  readonly langs: ReadonlyArray<string>;
}
export interface FilterRegex {
  readonly _tag: "Regex";
  readonly patterns: ReadonlyArray<string>;
  readonly flags?: string;
}
export interface FilterDateRange {
  readonly _tag: "DateRange";
  readonly start: Timestamp;
  readonly end: Timestamp;
}
export interface FilterHasValidLinks {
  readonly _tag: "HasValidLinks";
  readonly onError: FilterErrorPolicy;
}
export interface FilterTrending {
  readonly _tag: "Trending";
  readonly tag: Hashtag;
  readonly onError: FilterErrorPolicy;
}
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
  | FilterHasVideo
  | FilterHasLinks
  | FilterHasMedia
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
interface FilterHasVideoEncoded {
  readonly _tag: "HasVideo";
}
interface FilterHasLinksEncoded {
  readonly _tag: "HasLinks";
}
interface FilterHasMediaEncoded {
  readonly _tag: "HasMedia";
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
  | FilterHasVideoEncoded
  | FilterHasLinksEncoded
  | FilterHasMediaEncoded
  | FilterLanguageEncoded
  | FilterRegexEncoded
  | FilterDateRangeEncoded
  | FilterHasValidLinksEncoded
  | FilterTrendingEncoded;

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
  FilterHasVideoSchema,
  FilterHasLinksSchema,
  FilterHasMediaSchema,
  FilterLanguageSchema,
  FilterRegexSchema,
  FilterDateRangeSchema,
  FilterHasValidLinksSchema,
  FilterTrendingSchema
).annotations({ identifier: "FilterExpr" });

export const all = (): FilterAll => ({ _tag: "All" });
export const none = (): FilterNone => ({ _tag: "None" });
export const and = (left: FilterExpr, right: FilterExpr): FilterAnd => ({
  _tag: "And",
  left,
  right
});
export const or = (left: FilterExpr, right: FilterExpr): FilterOr => ({
  _tag: "Or",
  left,
  right
});
export const not = (expr: FilterExpr): FilterNot => ({ _tag: "Not", expr });

export const FilterExprSemigroup: Semigroup.Semigroup<FilterExpr> = Semigroup.make(
  (left, right) => and(left, right)
);

export const FilterExprMonoid: Monoid.Monoid<FilterExpr> = Monoid.fromSemigroup(
  FilterExprSemigroup,
  all()
);

export const encodeFilterExpr = (expr: FilterExpr): FilterExprEncoded =>
  Schema.encodeSync(FilterExprSchema)(expr);

export const filterExprSignature = (expr: FilterExpr): string =>
  JSON.stringify(encodeFilterExpr(expr));

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

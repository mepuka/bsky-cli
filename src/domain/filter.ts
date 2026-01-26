import { Schema } from "effect";
import * as Monoid from "@effect/typeclass/Monoid";
import * as Semigroup from "@effect/typeclass/Semigroup";
import { Handle, Hashtag, Timestamp } from "./primitives.js";
import { FilterErrorPolicy } from "./policies.js";

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
export interface FilterLlm {
  readonly _tag: "Llm";
  readonly prompt: string;
  readonly minConfidence: number;
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
  | FilterRegex
  | FilterDateRange
  | FilterHasValidLinks
  | FilterTrending
  | FilterLlm;

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
interface FilterLlmEncoded {
  readonly _tag: "Llm";
  readonly prompt: string;
  readonly minConfidence: number;
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
  | FilterRegexEncoded
  | FilterDateRangeEncoded
  | FilterHasValidLinksEncoded
  | FilterTrendingEncoded
  | FilterLlmEncoded;

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
  left: FilterExprSchema,
  right: FilterExprSchema
});
const FilterOrSchema: Schema.Schema<FilterOr, FilterOrEncoded, never> = Schema.TaggedStruct("Or", {
  left: FilterExprSchema,
  right: FilterExprSchema
});
const FilterNotSchema: Schema.Schema<FilterNot, FilterNotEncoded, never> = Schema.TaggedStruct("Not", {
  expr: FilterExprSchema
});
const FilterAuthorSchema: Schema.Schema<FilterAuthor, FilterAuthorEncoded, never> = Schema.TaggedStruct(
  "Author",
  { handle: Handle }
);
const FilterHashtagSchema: Schema.Schema<FilterHashtag, FilterHashtagEncoded, never> = Schema.TaggedStruct(
  "Hashtag",
  { tag: Hashtag }
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
  { patterns: RegexPatternsSchema, flags: Schema.optionalWith(Schema.String, { exact: true }) }
);
const FilterDateRangeSchema: Schema.Schema<
  FilterDateRange,
  FilterDateRangeEncoded,
  never
> = Schema.TaggedStruct("DateRange", {
  start: Timestamp,
  end: Timestamp
});
const FilterHasValidLinksSchema: Schema.Schema<
  FilterHasValidLinks,
  FilterHasValidLinksEncoded,
  never
> = Schema.TaggedStruct("HasValidLinks", { onError: FilterErrorPolicy });
const FilterTrendingSchema: Schema.Schema<FilterTrending, FilterTrendingEncoded, never> = Schema.TaggedStruct(
  "Trending",
  { tag: Hashtag, onError: FilterErrorPolicy }
);
const FilterLlmSchema: Schema.Schema<FilterLlm, FilterLlmEncoded, never> = Schema.TaggedStruct("Llm", {
  prompt: Schema.String,
  minConfidence: Schema.Number.pipe(Schema.finite(), Schema.between(0, 1)),
  onError: FilterErrorPolicy
});

const FilterExprInternal: Schema.Schema<FilterExpr, FilterExprEncoded, never> = Schema.Union(
  FilterAllSchema,
  FilterNoneSchema,
  FilterAndSchema,
  FilterOrSchema,
  FilterNotSchema,
  FilterAuthorSchema,
  FilterHashtagSchema,
  FilterRegexSchema,
  FilterDateRangeSchema,
  FilterHasValidLinksSchema,
  FilterTrendingSchema,
  FilterLlmSchema
);

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

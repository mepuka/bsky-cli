import { Schema } from "effect";
import { EmbedAspectRatio } from "./bsky.js";
import { Handle, PostUri } from "./primitives.js";

const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());

export class ImageRef extends Schema.Class<ImageRef>("ImageRef")({
  fullsizeUrl: Schema.String,
  thumbUrl: Schema.String,
  alt: Schema.optional(Schema.String),
  aspectRatio: Schema.optional(EmbedAspectRatio)
}) {}

export class ImageSummary extends Schema.Class<ImageSummary>("ImageSummary")({
  imageCount: NonNegativeInt,
  hasAltText: Schema.Boolean,
  thumbnailUrl: Schema.optional(Schema.String)
}) {}

export const EmbedSummaryType = Schema.Literal(
  "images",
  "video",
  "external",
  "record",
  "record_with_media",
  "unknown"
);
export type EmbedSummaryType = typeof EmbedSummaryType.Type;

export class EmbedExternalSummary extends Schema.Class<EmbedExternalSummary>(
  "EmbedExternalSummary"
)({
  uri: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  thumb: Schema.optional(Schema.String)
}) {}

export class EmbedRecordSummary extends Schema.Class<EmbedRecordSummary>(
  "EmbedRecordSummary"
)({
  uri: Schema.optional(PostUri),
  authorHandle: Schema.optional(Handle)
}) {}

export class EmbedSummary extends Schema.Class<EmbedSummary>("EmbedSummary")({
  type: EmbedSummaryType,
  imageSummary: Schema.optional(ImageSummary),
  external: Schema.optional(EmbedExternalSummary),
  record: Schema.optional(EmbedRecordSummary)
}) {}

export const ImageVariant = Schema.Literal("original", "thumb");
export type ImageVariant = typeof ImageVariant.Type;

export class ImageAsset extends Schema.Class<ImageAsset>("ImageAsset")({
  url: Schema.String,
  variant: ImageVariant,
  path: Schema.String,
  contentType: Schema.optional(Schema.String),
  size: NonNegativeInt,
  cachedAt: Schema.DateFromString
}) {}

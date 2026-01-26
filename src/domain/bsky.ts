import { Schema } from "effect";
import { Did, PostCid, PostUri, Timestamp } from "./primitives.js";

export class StrongRef extends Schema.Class<StrongRef>("StrongRef")({
  uri: PostUri,
  cid: PostCid
}) {}

export class ReplyRef extends Schema.Class<ReplyRef>("ReplyRef")({
  root: StrongRef,
  parent: StrongRef
}) {}

export const FacetIndex = Schema.Struct({
  byteStart: Schema.Number,
  byteEnd: Schema.Number
});
export type FacetIndex = typeof FacetIndex.Type;

export const FacetMentionFeature = Schema.Struct({
  $type: Schema.optional(Schema.Literal("app.bsky.richtext.facet#mention")),
  did: Did
});
export type FacetMentionFeature = typeof FacetMentionFeature.Type;

export const FacetLinkFeature = Schema.Struct({
  $type: Schema.optional(Schema.Literal("app.bsky.richtext.facet#link")),
  uri: Schema.String
});
export type FacetLinkFeature = typeof FacetLinkFeature.Type;

export const FacetTagFeature = Schema.Struct({
  $type: Schema.optional(Schema.Literal("app.bsky.richtext.facet#tag")),
  tag: Schema.String
});
export type FacetTagFeature = typeof FacetTagFeature.Type;

export const FacetUnknownFeature = Schema.Struct({
  $type: Schema.String
});
export type FacetUnknownFeature = typeof FacetUnknownFeature.Type;

export const FacetFeature = Schema.Union(
  FacetMentionFeature,
  FacetLinkFeature,
  FacetTagFeature,
  FacetUnknownFeature
);
export type FacetFeature = typeof FacetFeature.Type;

export const RichTextFacet = Schema.Struct({
  index: FacetIndex,
  features: Schema.Array(FacetFeature)
});
export type RichTextFacet = typeof RichTextFacet.Type;

export const SelfLabel = Schema.Struct({
  val: Schema.String
});
export type SelfLabel = typeof SelfLabel.Type;

export const SelfLabels = Schema.Struct({
  values: Schema.Array(SelfLabel)
});
export type SelfLabels = typeof SelfLabels.Type;

export class Label extends Schema.Class<Label>("Label")({
  src: Did,
  uri: Schema.String,
  cid: Schema.optional(Schema.String),
  val: Schema.String,
  neg: Schema.optional(Schema.Boolean),
  cts: Timestamp,
  exp: Schema.optional(Timestamp),
  sig: Schema.optional(Schema.String)
}) {}

export class PostMetrics extends Schema.Class<PostMetrics>("PostMetrics")({
  replyCount: Schema.optional(Schema.Number),
  repostCount: Schema.optional(Schema.Number),
  likeCount: Schema.optional(Schema.Number),
  quoteCount: Schema.optional(Schema.Number),
  bookmarkCount: Schema.optional(Schema.Number)
}) {}

export class EmbedAspectRatio extends Schema.Class<EmbedAspectRatio>("EmbedAspectRatio")({
  width: Schema.Number,
  height: Schema.Number
}) {}

export class EmbedImage extends Schema.Class<EmbedImage>("EmbedImage")({
  thumb: Schema.String,
  fullsize: Schema.String,
  alt: Schema.String,
  aspectRatio: Schema.optional(EmbedAspectRatio)
}) {}

export class EmbedImages extends Schema.TaggedClass<EmbedImages>()("Images", {
  images: Schema.Array(EmbedImage)
}) {}

export class EmbedExternal extends Schema.TaggedClass<EmbedExternal>()("External", {
  uri: Schema.String,
  title: Schema.String,
  description: Schema.String,
  thumb: Schema.optional(Schema.String)
}) {}

export class EmbedVideo extends Schema.TaggedClass<EmbedVideo>()("Video", {
  cid: Schema.String,
  playlist: Schema.String,
  thumbnail: Schema.optional(Schema.String),
  alt: Schema.optional(Schema.String),
  aspectRatio: Schema.optional(EmbedAspectRatio)
}) {}

export class EmbedRecord extends Schema.TaggedClass<EmbedRecord>()("Record", {
  recordType: Schema.optional(Schema.String),
  record: Schema.Unknown
}) {}

export class EmbedRecordWithMedia extends Schema.TaggedClass<EmbedRecordWithMedia>()(
  "RecordWithMedia",
  {
    recordType: Schema.optional(Schema.String),
    record: Schema.Unknown,
    media: Schema.Union(EmbedImages, EmbedExternal, EmbedVideo, Schema.Unknown)
  }
) {}

export class EmbedUnknown extends Schema.TaggedClass<EmbedUnknown>()("Unknown", {
  rawType: Schema.String,
  data: Schema.Unknown
}) {}

export const PostEmbed = Schema.Union(
  EmbedImages,
  EmbedExternal,
  EmbedVideo,
  EmbedRecord,
  EmbedRecordWithMedia,
  EmbedUnknown
);
export type PostEmbed = typeof PostEmbed.Type;

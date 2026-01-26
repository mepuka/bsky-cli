import { Schema } from "effect";
import { AtUri, Did, Handle, PostCid, PostUri, Timestamp } from "./primitives.js";

export class StrongRef extends Schema.Class<StrongRef>("StrongRef")({
  uri: AtUri,
  cid: PostCid
}) {}

export class ReplyRef extends Schema.Class<ReplyRef>("ReplyRef")({
  root: StrongRef,
  parent: StrongRef
}) {}

export const FacetIndex = Schema.Struct({
  byteStart: Schema.Int,
  byteEnd: Schema.Int
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

export const LegacyFacetIndex = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int
});
export type LegacyFacetIndex = typeof LegacyFacetIndex.Type;

export const LegacyEntity = Schema.Struct({
  index: LegacyFacetIndex,
  type: Schema.String,
  value: Schema.String
});
export type LegacyEntity = typeof LegacyEntity.Type;

export const SelfLabel = Schema.Struct({
  $type: Schema.optional(Schema.Literal("com.atproto.label.defs#selfLabel")),
  val: Schema.String
});
export type SelfLabel = typeof SelfLabel.Type;

export const SelfLabels = Schema.Struct({
  $type: Schema.optional(Schema.Literal("com.atproto.label.defs#selfLabels")),
  values: Schema.Array(SelfLabel)
});
export type SelfLabels = typeof SelfLabels.Type;

export class Label extends Schema.Class<Label>("Label")({
  $type: Schema.optional(Schema.Literal("com.atproto.label.defs#label")),
  ver: Schema.optional(Schema.Int),
  src: Did,
  uri: AtUri,
  cid: Schema.optional(Schema.String),
  val: Schema.String,
  neg: Schema.optional(Schema.Boolean),
  cts: Timestamp,
  exp: Schema.optional(Timestamp),
  sig: Schema.optional(
    Schema.Union(Schema.Uint8ArrayFromSelf, Schema.Uint8ArrayFromBase64)
  )
}) {}

const NonNegativeInt = Schema.Int.pipe(
  Schema.finite(),
  Schema.nonNegative()
);

export class PostMetrics extends Schema.Class<PostMetrics>("PostMetrics")({
  replyCount: Schema.optional(NonNegativeInt),
  repostCount: Schema.optional(NonNegativeInt),
  likeCount: Schema.optional(NonNegativeInt),
  quoteCount: Schema.optional(NonNegativeInt),
  bookmarkCount: Schema.optional(NonNegativeInt)
}) {}

export class EmbedAspectRatio extends Schema.Class<EmbedAspectRatio>("EmbedAspectRatio")({
  width: Schema.Int,
  height: Schema.Int
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

export class ProfileBasic extends Schema.Class<ProfileBasic>("ProfileBasic")({
  did: Did,
  handle: Handle,
  displayName: Schema.optional(Schema.String),
  pronouns: Schema.optional(Schema.String),
  avatar: Schema.optional(Schema.String),
  associated: Schema.optional(Schema.Unknown),
  viewer: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Array(Schema.encodedSchema(Label))),
  createdAt: Schema.optional(Schema.String),
  verification: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
  debug: Schema.optional(Schema.Unknown)
}) {}

export class EmbedRecordView extends Schema.TaggedClass<EmbedRecordView>()(
  "RecordView",
  {
    uri: PostUri,
    cid: PostCid,
    author: ProfileBasic,
    value: Schema.Unknown,
    labels: Schema.optional(Schema.Array(Label)),
    metrics: Schema.optional(PostMetrics),
    embeds: Schema.optional(Schema.Array(Schema.Unknown)),
    indexedAt: Timestamp
  }
) {}

export class EmbedRecordNotFound extends Schema.TaggedClass<EmbedRecordNotFound>()(
  "RecordNotFound",
  {
    uri: PostUri,
    notFound: Schema.Literal(true)
  }
) {}

export class BlockedAuthor extends Schema.Class<BlockedAuthor>("BlockedAuthor")({
  did: Did,
  viewer: Schema.optional(Schema.Unknown)
}) {}

export class EmbedRecordBlocked extends Schema.TaggedClass<EmbedRecordBlocked>()(
  "RecordBlocked",
  {
    uri: PostUri,
    blocked: Schema.Literal(true),
    author: BlockedAuthor
  }
) {}

export class EmbedRecordDetached extends Schema.TaggedClass<EmbedRecordDetached>()(
  "RecordDetached",
  {
    uri: PostUri,
    detached: Schema.Literal(true)
  }
) {}

export class EmbedRecordUnknown extends Schema.TaggedClass<EmbedRecordUnknown>()(
  "RecordUnknown",
  {
    rawType: Schema.String,
    data: Schema.Unknown
  }
) {}

export const EmbedRecordTarget = Schema.Union(
  EmbedRecordView,
  EmbedRecordNotFound,
  EmbedRecordBlocked,
  EmbedRecordDetached,
  EmbedRecordUnknown
);
export type EmbedRecordTarget = typeof EmbedRecordTarget.Type;

export class EmbedRecord extends Schema.TaggedClass<EmbedRecord>()("Record", {
  recordType: Schema.optional(Schema.String),
  record: Schema.suspend(() => EmbedRecordTarget)
}) {}

export class EmbedRecordWithMedia extends Schema.TaggedClass<EmbedRecordWithMedia>()(
  "RecordWithMedia",
  {
    recordType: Schema.optional(Schema.String),
    record: Schema.suspend(() => EmbedRecordTarget),
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

export const PostViewerState = Schema.Struct({
  repost: Schema.optional(AtUri),
  like: Schema.optional(AtUri),
  bookmarked: Schema.optional(Schema.Boolean),
  threadMuted: Schema.optional(Schema.Boolean),
  replyDisabled: Schema.optional(Schema.Boolean),
  embeddingDisabled: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean)
});
export type PostViewerState = typeof PostViewerState.Type;

export const ThreadgateView = Schema.Struct({
  uri: Schema.optional(AtUri),
  cid: Schema.optional(Schema.String),
  record: Schema.optional(Schema.Unknown),
  lists: Schema.optional(Schema.Array(Schema.Unknown))
});
export type ThreadgateView = typeof ThreadgateView.Type;

export class FeedPostViewRef extends Schema.Class<FeedPostViewRef>("FeedPostViewRef")({
  uri: PostUri,
  cid: PostCid,
  author: ProfileBasic,
  indexedAt: Timestamp,
  labels: Schema.optional(Schema.Array(Label)),
  viewer: Schema.optional(PostViewerState)
}) {}

export class FeedPostNotFound extends Schema.TaggedClass<FeedPostNotFound>()(
  "FeedPostNotFound",
  {
    uri: PostUri,
    notFound: Schema.Literal(true)
  }
) {}

export class FeedPostBlocked extends Schema.TaggedClass<FeedPostBlocked>()(
  "FeedPostBlocked",
  {
    uri: PostUri,
    blocked: Schema.Literal(true),
    author: BlockedAuthor
  }
) {}

export class FeedPostUnknown extends Schema.TaggedClass<FeedPostUnknown>()(
  "FeedPostUnknown",
  {
    rawType: Schema.String,
    data: Schema.Unknown
  }
) {}

export const FeedPostReference = Schema.Union(
  FeedPostViewRef,
  FeedPostNotFound,
  FeedPostBlocked,
  FeedPostUnknown
);
export type FeedPostReference = typeof FeedPostReference.Type;

export class FeedReplyRef extends Schema.Class<FeedReplyRef>("FeedReplyRef")({
  root: FeedPostReference,
  parent: FeedPostReference,
  grandparentAuthor: Schema.optional(ProfileBasic)
}) {}

export class FeedReasonRepost extends Schema.TaggedClass<FeedReasonRepost>()(
  "ReasonRepost",
  {
    by: ProfileBasic,
    uri: Schema.optional(PostUri),
    cid: Schema.optional(PostCid),
    indexedAt: Timestamp
  }
) {}

export class FeedReasonPin extends Schema.TaggedClass<FeedReasonPin>()("ReasonPin", {}) {}

export class FeedReasonUnknown extends Schema.TaggedClass<FeedReasonUnknown>()(
  "ReasonUnknown",
  {
    rawType: Schema.String,
    data: Schema.Unknown
  }
) {}

export const FeedReason = Schema.Union(
  FeedReasonRepost,
  FeedReasonPin,
  FeedReasonUnknown
);
export type FeedReason = typeof FeedReason.Type;

export class FeedContext extends Schema.Class<FeedContext>("FeedContext")({
  reply: Schema.optional(FeedReplyRef),
  reason: Schema.optional(FeedReason),
  feedContext: Schema.optional(Schema.String),
  reqId: Schema.optional(Schema.String)
}) {}

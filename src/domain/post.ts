import { Schema } from "effect";
import { Did, Handle, Hashtag, PostCid, PostUri, Timestamp } from "./primitives.js";
import {
  FeedContext,
  Label,
  PostEmbed,
  PostMetrics,
  PostViewerState,
  ProfileBasic,
  ReplyRef,
  RichTextFacet,
  SelfLabel,
  ThreadgateView
} from "./bsky.js";

export class Post extends Schema.Class<Post>("Post")({
  uri: PostUri,
  cid: Schema.optional(PostCid),
  author: Handle,
  authorDid: Schema.optional(Did),
  authorProfile: Schema.optional(ProfileBasic),
  text: Schema.String,
  createdAt: Timestamp,
  hashtags: Schema.Array(Hashtag),
  mentions: Schema.Array(Handle),
  mentionDids: Schema.optional(Schema.Array(Did)),
  links: Schema.Array(Schema.URL),
  facets: Schema.optional(Schema.Array(RichTextFacet)),
  reply: Schema.optional(ReplyRef),
  embed: Schema.optional(PostEmbed),
  recordEmbed: Schema.optional(Schema.Unknown),
  langs: Schema.optional(Schema.Array(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  selfLabels: Schema.optional(Schema.Array(SelfLabel)),
  labels: Schema.optional(Schema.Array(Label)),
  metrics: Schema.optional(PostMetrics),
  indexedAt: Schema.optional(Timestamp),
  viewer: Schema.optional(PostViewerState),
  threadgate: Schema.optional(ThreadgateView),
  debug: Schema.optional(Schema.Unknown),
  feed: Schema.optional(FeedContext)
}) {}

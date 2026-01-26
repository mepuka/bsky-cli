import { Schema } from "effect";
import { Did, Handle, Hashtag, PostCid, PostUri, Timestamp } from "./primitives.js";
import {
  Label,
  PostEmbed,
  PostMetrics,
  ReplyRef,
  RichTextFacet,
  SelfLabel
} from "./bsky.js";

export class Post extends Schema.Class<Post>("Post")({
  uri: PostUri,
  cid: Schema.optional(PostCid),
  author: Handle,
  authorDid: Schema.optional(Did),
  text: Schema.String,
  createdAt: Timestamp,
  hashtags: Schema.Array(Hashtag),
  mentions: Schema.Array(Handle),
  mentionDids: Schema.optional(Schema.Array(Did)),
  links: Schema.Array(Schema.URL),
  facets: Schema.optional(Schema.Array(RichTextFacet)),
  reply: Schema.optional(ReplyRef),
  embed: Schema.optional(PostEmbed),
  langs: Schema.optional(Schema.Array(Schema.String)),
  selfLabels: Schema.optional(Schema.Array(SelfLabel)),
  labels: Schema.optional(Schema.Array(Label)),
  metrics: Schema.optional(PostMetrics),
  indexedAt: Schema.optional(Timestamp)
}) {}

import { ParseResult, Schema } from "effect";
import { extractFromFacets, extractHashtags, extractLinks, extractMentions } from "./extract.js";
import { Post } from "./post.js";
import { Did, Handle, PostCid, PostUri } from "./primitives.js";
import {
  Label,
  PostEmbed,
  PostMetrics,
  ReplyRef,
  RichTextFacet,
  SelfLabels
} from "./bsky.js";

export class RawPostRecord extends Schema.Class<RawPostRecord>("RawPostRecord")({
  text: Schema.String,
  createdAt: Schema.String,
  facets: Schema.optional(Schema.Array(RichTextFacet)),
  reply: Schema.optional(ReplyRef),
  embed: Schema.optional(Schema.Unknown),
  langs: Schema.optional(Schema.Array(Schema.String)),
  labels: Schema.optional(SelfLabels),
  tags: Schema.optional(Schema.Array(Schema.String))
}) {}

export class RawPost extends Schema.Class<RawPost>("RawPost")({
  uri: PostUri,
  cid: Schema.optional(PostCid),
  author: Handle,
  authorDid: Schema.optional(Did),
  record: RawPostRecord,
  indexedAt: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.encodedSchema(Label))),
  metrics: Schema.optional(PostMetrics),
  embed: Schema.optional(PostEmbed)
}) {}

export const PostFromRaw = Schema.transformOrFail(RawPost, Post, {
  strict: true,
  decode: (raw) => {
    const unique = <T>(items: ReadonlyArray<T>) => Array.from(new Set(items));
    const facetData = extractFromFacets(raw.record.facets);
    const tagOverrides =
      raw.record.tags?.map((tag) =>
        tag.startsWith("#") ? tag : `#${tag}`
      ) ?? [];
    const hashtags = unique([
      ...extractHashtags(raw.record.text),
      ...facetData.hashtags,
      ...tagOverrides
    ]);
    const mentions = unique(extractMentions(raw.record.text));
    const links = unique([
      ...extractLinks(raw.record.text),
      ...facetData.links
    ]);

    return ParseResult.succeed({
      uri: raw.uri,
      cid: raw.cid,
      author: raw.author,
      authorDid: raw.authorDid,
      text: raw.record.text,
      createdAt: raw.record.createdAt,
      hashtags,
      mentions,
      mentionDids: facetData.mentionDids,
      links,
      facets: raw.record.facets,
      reply: raw.record.reply,
      embed: raw.embed,
      langs: raw.record.langs,
      selfLabels: raw.record.labels?.values,
      labels: raw.labels,
      metrics: raw.metrics,
      indexedAt: raw.indexedAt
    });
  },
  encode: (post) =>
    ParseResult.decodeUnknown(RawPost)({
      uri: post.uri,
      cid: post.cid,
      author: post.author,
      authorDid: post.authorDid,
      indexedAt: post.indexedAt,
      labels: post.labels,
      metrics: post.metrics,
      embed: post.embed,
      record: {
        text: post.text,
        createdAt: post.createdAt,
        facets: post.facets,
        reply: post.reply,
        langs: post.langs,
        labels: post.selfLabels ? { values: post.selfLabels } : undefined
      }
    })
});

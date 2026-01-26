import { Effect, ParseResult, Schema } from "effect";
import { extractFromFacets, extractHashtags, extractLinks, extractMentions } from "./extract.js";
import { Post } from "./post.js";
import { Did, Handle, PostCid, PostUri } from "./primitives.js";
import {
  EmbedUnknown,
  FeedContext,
  Label,
  LegacyEntity,
  PostEmbed,
  PostMetrics,
  PostViewerState,
  ReplyRef,
  RichTextFacet,
  SelfLabels,
  ThreadgateView
} from "./bsky.js";

export class RawPostRecord extends Schema.Class<RawPostRecord>("RawPostRecord")({
  $type: Schema.optional(Schema.Literal("app.bsky.feed.post")),
  text: Schema.String,
  createdAt: Schema.String,
  facets: Schema.optional(Schema.Array(RichTextFacet)),
  entities: Schema.optional(Schema.Array(LegacyEntity)),
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
  embed: Schema.optional(PostEmbed),
  viewer: Schema.optional(PostViewerState),
  threadgate: Schema.optional(ThreadgateView),
  debug: Schema.optional(Schema.Unknown),
  feed: Schema.optional(FeedContext)
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
    const embed =
      raw.embed ??
      (raw.record.embed
        ? EmbedUnknown.make({
            rawType:
              typeof (raw.record.embed as { $type?: unknown })?.$type === "string"
                ? String((raw.record.embed as { $type?: unknown }).$type)
                : "unknown",
            data: raw.record.embed
          })
        : undefined);
    return ParseResult.decodeUnknown(Schema.encodedSchema(Post))({
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
      embed,
      langs: raw.record.langs,
      tags: raw.record.tags,
      selfLabels: raw.record.labels?.values,
      labels: raw.labels,
      metrics: raw.metrics,
      indexedAt: raw.indexedAt,
      viewer: raw.viewer,
      threadgate: raw.threadgate,
      debug: raw.debug,
      feed: raw.feed,
      recordEmbed: raw.record.embed
    });
  },
  encode: (_encoded, _options, _ast, post) =>
    Effect.gen(function* () {
      const labels = post.labels
        ? yield* ParseResult.encodeUnknown(Schema.Array(Label))(post.labels)
        : undefined;
      return yield* ParseResult.decodeUnknown(RawPost)({
        uri: post.uri,
        cid: post.cid,
        author: post.author,
        authorDid: post.authorDid,
        indexedAt: post.indexedAt?.toISOString(),
        labels,
        metrics: post.metrics,
        embed: post.embed,
        viewer: post.viewer,
        threadgate: post.threadgate,
        debug: post.debug,
        feed: post.feed,
        record: {
          text: post.text,
          createdAt: post.createdAt.toISOString(),
          facets: post.facets,
          reply: post.reply,
          embed: post.recordEmbed,
          langs: post.langs,
          labels: post.selfLabels ? { values: post.selfLabels } : undefined,
          tags: post.tags
        }
      });
    })
});

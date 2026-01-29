import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { ann, metric } from "./primitives.js";
import { normalizeWhitespace, truncate } from "../../domain/format.js";
import type { Post } from "../../domain/post.js";
import type { PostEmbed } from "../../domain/bsky.js";

type SDoc = Doc.Doc<Annotation>;

const renderEmbedSummary = (embed: PostEmbed): SDoc => {
  switch (embed._tag) {
    case "Images":    return Doc.text(`[Images: ${embed.images.length}]`);
    case "External":  return Doc.text(`[Link: ${truncate(embed.title || embed.uri, 40)}]`);
    case "Video":     return Doc.text("[Video]");
    case "Record":
      return Doc.text(
        embed.record._tag === "RecordView"
          ? `[Quote: @${embed.record.author.handle}]`
          : "[Quote]"
      );
    case "RecordWithMedia":
      return Doc.text(
        embed.record._tag === "RecordView"
          ? `[Quote: @${embed.record.author.handle} + media]`
          : "[Quote + media]"
      );
    default:          return Doc.text("[Embed]");
  }
};

export const renderPostCompact = (post: Post): SDoc => {
  const parts: SDoc[] = [
    ann("author", Doc.text(`@${post.author}`)),
    ann("dim", Doc.text("·")),
    ann("timestamp", Doc.text(post.createdAt.toISOString().slice(0, 10))),
    Doc.text(truncate(normalizeWhitespace(post.text), 60))
  ];
  if (post.metrics) {
    const m = post.metrics;
    if (m.likeCount != null && m.likeCount > 0) parts.push(metric("♥", m.likeCount));
    if (m.repostCount != null && m.repostCount > 0) parts.push(metric("↻", m.repostCount));
    if (m.replyCount != null && m.replyCount > 0) parts.push(metric("💬", m.replyCount));
  }
  return Doc.hsep(parts);
};

/** Returns an array of Doc lines suitable for multi-line tree rendering.
 *  When used standalone, combine with `Doc.vsep(renderPostCard(post))`. */
export const renderPostCard = (post: Post): ReadonlyArray<SDoc> => {
  const lines: SDoc[] = [];

  lines.push(Doc.hsep([
    ann("author", Doc.text(`@${post.author}`)),
    ann("dim", Doc.text("·")),
    ann("timestamp", Doc.text(post.createdAt.toISOString()))
  ]));

  lines.push(Doc.reflow(normalizeWhitespace(post.text)));

  if (post.embed) lines.push(ann("embed", renderEmbedSummary(post.embed)));

  if (post.metrics) {
    const parts: SDoc[] = [];
    const m = post.metrics;
    if (m.likeCount != null && m.likeCount > 0) parts.push(metric("♥", m.likeCount));
    if (m.repostCount != null && m.repostCount > 0) parts.push(metric("↻", m.repostCount));
    if (m.replyCount != null && m.replyCount > 0) parts.push(metric("💬", m.replyCount));
    if (m.quoteCount != null && m.quoteCount > 0) parts.push(metric("❝", m.quoteCount));
    if (parts.length > 0) lines.push(Doc.hsep(parts));
  }

  return lines;
};

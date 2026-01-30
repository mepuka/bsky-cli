import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { ann, metric } from "./primitives.js";
import { collapseWhitespace, normalizeWhitespace, truncate } from "../../domain/format.js";
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

const wrapText = (text: string, maxWidth?: number): ReadonlyArray<string> => {
  const normalized = normalizeWhitespace(text);
  if (!maxWidth || maxWidth <= 0) {
    const lines = normalized.split("\n");
    return lines.length > 0 ? lines : [normalized];
  }
  const lines: string[] = [];
  const paragraphs = normalized.split("\n");
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let current = "";
    const flushCurrent = () => {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
    };
    for (let word of words) {
      while (word.length > maxWidth && maxWidth > 1) {
        const chunk = word.slice(0, maxWidth - 1);
        flushCurrent();
        lines.push(`${chunk}-`);
        word = word.slice(maxWidth - 1);
      }
      if (current.length === 0) {
        current = word;
        continue;
      }
      if (current.length + 1 + word.length <= maxWidth) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    flushCurrent();
  }
  return lines.length > 0 ? lines : [normalized];
};

export const renderPostCompact = (post: Post): SDoc => {
  const text = post.text ?? "";
  const parts: SDoc[] = [
    ann("author", Doc.text(`@${post.author}`)),
    ann("dim", Doc.text("·")),
    ann("timestamp", Doc.text(post.createdAt.toISOString().slice(0, 10))),
    Doc.text(truncate(collapseWhitespace(text), 60))
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
  const text = post.text ?? "";
  const lines: SDoc[] = [];

  lines.push(Doc.hsep([
    ann("author", Doc.text(`@${post.author}`)),
    ann("dim", Doc.text("·")),
    ann("timestamp", Doc.text(post.createdAt.toISOString()))
  ]));

  const paragraphs = normalizeWhitespace(text).split("\n");
  lines.push(Doc.vsep(paragraphs.map((paragraph) => Doc.reflow(paragraph))));

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

export const renderPostCardLines = (
  post: Post,
  options?: { lineWidth?: number }
): ReadonlyArray<SDoc> => {
  const text = post.text ?? "";
  const lines: SDoc[] = [];

  lines.push(Doc.hsep([
    ann("author", Doc.text(`@${post.author}`)),
    ann("dim", Doc.text("·")),
    ann("timestamp", Doc.text(post.createdAt.toISOString()))
  ]));

  const textLines = wrapText(text, options?.lineWidth);
  for (const line of textLines) {
    lines.push(Doc.text(line));
  }

  if (post.embed) {
    lines.push(ann("embed", renderEmbedSummary(post.embed)));
  }

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

import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { ann, metric } from "./primitives.js";
import { collapseWhitespace, normalizeWhitespace, truncate } from "../../domain/format.js";
import type { Post } from "../../domain/post.js";
import type { EmbedRecordTarget, PostEmbed } from "../../domain/bsky.js";
import {
  isEmbedExternal,
  isEmbedImages,
  isEmbedRecord,
  isEmbedRecordView,
  isEmbedRecordWithMedia,
  isEmbedVideo
} from "../../domain/bsky.js";
import { embedMedia, extractImageRefs } from "../../domain/embeds.js";

type SDoc = Doc.Doc<Annotation>;

const recordAuthor = (record: EmbedRecordTarget) =>
  isEmbedRecordView(record) ? record.author.handle : undefined;

const renderEmbedSummary = (embed: PostEmbed): SDoc => {
  if (isEmbedImages(embed)) {
    return Doc.text(`[Images: ${embed.images.length}]`);
  }
  if (isEmbedExternal(embed)) {
    return Doc.text(`[Link: ${truncate(embed.title || embed.uri, 40)}]`);
  }
  if (isEmbedVideo(embed)) {
    return Doc.text("[Video]");
  }
  if (isEmbedRecord(embed)) {
    const author = recordAuthor(embed.record);
    return Doc.text(author ? `[Quote: @${author}]` : "[Quote]");
  }
  if (isEmbedRecordWithMedia(embed)) {
    const author = recordAuthor(embed.record);
    const media = embedMedia(embed);
    if (media && isEmbedImages(media)) {
      return Doc.text(
        author
          ? `[Quote: @${author} + ${media.images.length} images]`
          : `[Quote + ${media.images.length} images]`
      );
    }
    if (media && isEmbedExternal(media)) {
      return Doc.text(author ? `[Quote: @${author} + Link]` : "[Quote + Link]");
    }
    if (media && isEmbedVideo(media)) {
      return Doc.text(author ? `[Quote: @${author} + Video]` : "[Quote + Video]");
    }
    return Doc.text(author ? `[Quote: @${author} + media]` : "[Quote + media]");
  }
  return Doc.text("[Embed]");
};

const compactEmbedLabel = (embed: PostEmbed): string => {
  if (isEmbedImages(embed)) {
    return `${embed.images.length}img`;
  }
  if (isEmbedExternal(embed)) {
    return "link";
  }
  if (isEmbedVideo(embed)) {
    return "video";
  }
  if (isEmbedRecord(embed)) {
    return "quote";
  }
  if (isEmbedRecordWithMedia(embed)) {
    const media = embedMedia(embed);
    if (media && isEmbedImages(media)) return `quote+${media.images.length}img`;
    if (media && isEmbedExternal(media)) return "quote+link";
    if (media && isEmbedVideo(media)) return "quote+video";
    return "quote+media";
  }
  return "embed";
};

const detailMaxWidth = (lineWidth?: number) =>
  lineWidth ? Math.max(20, lineWidth - 6) : 80;

const renderEmbedDetails = (
  embed: PostEmbed,
  options?: { lineWidth?: number }
): ReadonlyArray<SDoc> => {
  const lines: SDoc[] = [ann("embed", renderEmbedSummary(embed))];
  const maxWidth = detailMaxWidth(options?.lineWidth);
  const addDetail = (label: string, value: string) => {
    const normalized = truncate(collapseWhitespace(value), maxWidth);
    if (normalized.length > 0) {
      lines.push(ann("dim", Doc.text(`${label}: ${normalized}`)));
    }
  };

  const imageRefs = extractImageRefs(embed);
  const altTexts = imageRefs
    .map((ref) => ref.alt)
    .filter((alt): alt is string => typeof alt === "string" && alt.trim().length > 0);
  const shownAlt = altTexts.slice(0, 2);
  for (const alt of shownAlt) {
    addDetail("alt", alt);
  }
  if (altTexts.length > shownAlt.length) {
    lines.push(ann("dim", Doc.text(`alt: +${altTexts.length - shownAlt.length} more`)));
  }

  if (isEmbedVideo(embed) && embed.alt) {
    addDetail("alt", embed.alt);
  }

  if (isEmbedExternal(embed) && embed.description) {
    addDetail("desc", embed.description);
  }
  if (isEmbedRecordWithMedia(embed)) {
    const media = embedMedia(embed);
    if (media && isEmbedExternal(media) && media.description) {
      addDetail("desc", media.description);
    }
  }

  return lines;
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
  if (post.embed) {
    parts.push(ann("embed", Doc.text(compactEmbedLabel(post.embed))));
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

  if (post.embed) lines.push(...renderEmbedDetails(post.embed));

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
    lines.push(...renderEmbedDetails(post.embed, options));
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

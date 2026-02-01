import type { PostEmbed } from "./bsky.js";
import { summarizeEmbed } from "./embeds.js";
import { Post } from "./post.js";
import { displayWidth, padEndDisplay } from "./text-width.js";

const headers = ["Created At", "Author", "Text", "Embed", "URI"];
const headersWithStore = ["Store", ...headers];
const textLimit = 80;

export const normalizeWhitespace = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();

export const collapseWhitespace = (text: string) =>
  normalizeWhitespace(text).replace(/\n+/g, " ").trim();

export const truncate = (text: string, max: number) => {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
};

const sanitizeText = (text: string) => truncate(collapseWhitespace(text), textLimit);

const sanitizeMarkdown = (text: string) =>
  sanitizeText(text).replace(/[\\|*_`\[\]]/g, "\\$&");

const formatEmbedSummary = (embed?: PostEmbed) => {
  const summary = summarizeEmbed(embed);
  if (!summary) return "";
  const hostFromUrl = (uri: string) => {
    try {
      return new URL(uri).hostname;
    } catch {
      return undefined;
    }
  };
  switch (summary.type) {
    case "images": {
      const count = summary.imageSummary?.imageCount ?? 0;
      return count > 0 ? `${count}img` : "img";
    }
    case "video":
      return "video";
    case "external": {
      const host = summary.external?.uri ? hostFromUrl(summary.external.uri) : undefined;
      return host ? `link:${host}` : "link";
    }
    case "record": {
      const author = summary.record?.authorHandle;
      return author ? `quote:@${author}` : "quote";
    }
    case "record_with_media": {
      const author = summary.record?.authorHandle;
      const base = author ? `quote:@${author}` : "quote";
      if (summary.imageSummary) {
        const count = summary.imageSummary.imageCount;
        return count > 0 ? `${base}+${count}img` : `${base}+img`;
      }
      if (summary.external?.uri) {
        const host = hostFromUrl(summary.external.uri);
        return host ? `${base}+link:${host}` : `${base}+link`;
      }
      return `${base}+media`;
    }
    default:
      return "embed";
  }
};

const postToRow = (post: Post) => [
  post.createdAt.toISOString(),
  post.author,
  sanitizeText(post.text),
  sanitizeText(formatEmbedSummary(post.embed)),
  post.uri
];

const postToMarkdownRow = (post: Post) => [
  post.createdAt.toISOString(),
  post.author,
  sanitizeMarkdown(post.text),
  sanitizeMarkdown(formatEmbedSummary(post.embed)),
  post.uri.replace(/\|/g, "\\|")
];

const storePostToRow = (entry: { readonly store: string; readonly post: Post }) => [
  entry.store,
  ...postToRow(entry.post)
];

const storePostToMarkdownRow = (entry: { readonly store: string; readonly post: Post }) => [
  entry.store,
  ...postToMarkdownRow(entry.post)
];

const renderTable = (
  head: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const widths = head.map((value, index) =>
    Math.max(
      displayWidth(value),
      ...rows.map((row) => displayWidth(row[index] ?? ""))
    )
  );

  const formatRow = (row: ReadonlyArray<string>) =>
    row
      .map((cell, index) => padEndDisplay(cell ?? "", widths[index] ?? 0))
      .join("  ");

  const header = formatRow(head);
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map(formatRow);

  return [header, separator, ...body].join("\n");
};

const renderMarkdownHeader = (head: ReadonlyArray<string>) => {
  const header = `| ${head.join(" | ")} |`;
  const separator = `| ${head.map((label) => "-".repeat(Math.max(label.length, 3))).join(" | ")} |`;
  return `${header}\n${separator}`;
};

export const renderPostsMarkdownHeader = () => renderMarkdownHeader(headers);

export const renderPostMarkdownRow = (post: Post) =>
  `| ${postToMarkdownRow(post).join(" | ")} |`;

const renderMarkdownTable = (
  head: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const header = renderMarkdownHeader(head);
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, ...body].join("\n");
};

export const renderPostsTable = (posts: ReadonlyArray<Post>) =>
  renderTable(headers, posts.map(postToRow));

export const renderPostsMarkdown = (posts: ReadonlyArray<Post>) =>
  renderMarkdownTable(headers, posts.map(postToMarkdownRow));

export const renderStorePostsTable = (
  entries: ReadonlyArray<{ readonly store: string; readonly post: Post }>
) =>
  renderTable(headersWithStore, entries.map(storePostToRow));

export const renderStorePostsMarkdown = (
  entries: ReadonlyArray<{ readonly store: string; readonly post: Post }>
) =>
  renderMarkdownTable(headersWithStore, entries.map(storePostToMarkdownRow));

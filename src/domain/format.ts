import { Post } from "./post.js";
import { displayWidth, padEndDisplay } from "./text-width.js";

const headers = ["Created At", "Author", "Text", "URI"];
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

const postToRow = (post: Post) => [
  post.createdAt.toISOString(),
  post.author,
  sanitizeText(post.text),
  post.uri
];

const postToMarkdownRow = (post: Post) => [
  post.createdAt.toISOString(),
  post.author,
  sanitizeMarkdown(post.text),
  post.uri.replace(/\|/g, "\\|")
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

const renderMarkdownTable = (
  head: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const header = `| ${head.join(" | ")} |`;
  const separator = `| ${head.map((label) => "-".repeat(Math.max(label.length, 3))).join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
};

export const renderPostsTable = (posts: ReadonlyArray<Post>) =>
  renderTable(headers, posts.map(postToRow));

export const renderPostsMarkdown = (posts: ReadonlyArray<Post>) =>
  renderMarkdownTable(headers, posts.map(postToMarkdownRow));

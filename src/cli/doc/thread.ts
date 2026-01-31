import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { renderTree } from "./tree.js";
import { renderPostCompact, renderPostCardLines } from "./post.js";
import type { Post } from "../../domain/post.js";
import { PostOrder } from "../../domain/order.js";

export const renderThread = (
  posts: ReadonlyArray<Post>,
  options?: { compact?: boolean; lineWidth?: number }
): Doc.Doc<Annotation> => {
  const byUri = new Map(posts.map((p) => [String(p.uri), p]));
  const childMap = new Map<string, Post[]>();
  const roots: Post[] = [];

  for (const post of posts) {
    const parentUri = post.reply?.parent.uri ? String(post.reply.parent.uri) : undefined;
    if (parentUri && byUri.has(parentUri)) {
      const siblings = childMap.get(parentUri) ?? [];
      siblings.push(post);
      childMap.set(parentUri, siblings);
    } else {
      roots.push(post);
    }
  }

  const sortPosts = (arr: Post[]) => arr.sort(PostOrder);

  sortPosts(roots);
  for (const children of childMap.values()) sortPosts(children);

  const cardOptions =
    options?.lineWidth === undefined ? undefined : { lineWidth: options.lineWidth };
  const render = options?.compact
    ? renderPostCompact
    : (post: Post) => renderPostCardLines(post, cardOptions);

  return renderTree<Post, undefined>(roots, {
    children: (post) =>
      (childMap.get(String(post.uri)) ?? []).map((p) => ({ node: p, edge: undefined })),
    renderNode: (post) => render(post),
    key: (post) => String(post.uri),
  });
};

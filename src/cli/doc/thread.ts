import * as Doc from "@effect/printer/Doc";
import type { Annotation } from "./annotation.js";
import { renderTree } from "./tree.js";
import { renderPostCompact, renderPostCard } from "./post.js";
import type { Post } from "../../domain/post.js";

export const renderThread = (
  posts: ReadonlyArray<Post>,
  options?: { compact?: boolean }
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

  const sortPosts = (arr: Post[]) =>
    arr.sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.uri.localeCompare(b.uri)
    );

  sortPosts(roots);
  for (const children of childMap.values()) sortPosts(children);

  const render = options?.compact ? renderPostCompact : renderPostCard;

  return renderTree<Post, undefined>(roots, {
    children: (post) =>
      (childMap.get(String(post.uri)) ?? []).map((p) => ({ node: p, edge: undefined })),
    renderNode: (post) => render(post),
    key: (post) => String(post.uri),
  });
};

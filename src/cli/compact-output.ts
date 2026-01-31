import type { FeedGeneratorView, ListItemView, ListView, PostLike, ProfileView } from "../domain/bsky.js";
import type { Post } from "../domain/post.js";

type CompactProfile = {
  readonly did: ProfileView["did"];
  readonly handle: ProfileView["handle"];
  readonly displayName?: string;
};

const compactProfile = (profile: ProfileView): CompactProfile => ({
  did: profile.did,
  handle: profile.handle,
  ...(profile.displayName ? { displayName: profile.displayName } : {})
});

export const compactProfileView = (profile: ProfileView) =>
  compactProfile(profile);

export const compactFeedGeneratorView = (feed: FeedGeneratorView) => ({
  uri: feed.uri,
  displayName: feed.displayName,
  creator: compactProfile(feed.creator),
  ...(feed.likeCount !== undefined ? { likeCount: feed.likeCount } : {})
});

export const compactListView = (list: ListView) => ({
  uri: list.uri,
  name: list.name,
  purpose: list.purpose,
  creator: compactProfile(list.creator),
  ...(list.listItemCount !== undefined
    ? { listItemCount: list.listItemCount }
    : {})
});

export const compactListItemView = (item: ListItemView) => ({
  uri: item.uri,
  subject: compactProfile(item.subject)
});

export const compactPostLike = (like: PostLike) => ({
  actor: compactProfile(like.actor),
  createdAt: like.createdAt,
  indexedAt: like.indexedAt
});

export const compactPost = (post: Post) => ({
  uri: post.uri,
  author: post.author,
  text: post.text,
  createdAt: post.createdAt
});

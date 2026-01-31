import { renderTableLegacy } from "./table.js";
import type { FeedGeneratorView, ProfileView } from "../../domain/bsky.js";

export const renderProfileTable = (
  actors: ReadonlyArray<ProfileView>,
  cursor: string | undefined
) => {
  const rows = actors.map((actor) => [
    actor.handle,
    actor.displayName ?? "",
    actor.did
  ]);
  const table = renderTableLegacy(["HANDLE", "DISPLAY NAME", "DID"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

export const renderFeedTable = (
  feeds: ReadonlyArray<FeedGeneratorView>,
  cursor: string | undefined
) => {
  const rows = feeds.map((feed) => [
    feed.displayName,
    feed.creator.handle,
    feed.uri,
    typeof feed.likeCount === "number" ? String(feed.likeCount) : ""
  ]);
  const table = renderTableLegacy(["NAME", "CREATOR", "URI", "LIKES"], rows);
  return cursor ? `${table}\n\nCursor: ${cursor}` : table;
};

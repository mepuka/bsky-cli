import { Schema } from "effect";
import { Did, Handle, Hashtag, PostCid, PostUri, Timestamp } from "./primitives.js";
import {
  FeedContext,
  Label,
  PostEmbed,
  PostMetrics,
  PostViewerState,
  ProfileBasic,
  ReplyRef,
  RichTextFacet,
  SelfLabel,
  ThreadgateView
} from "./bsky.js";

/**
 * A normalized Bluesky post suitable for storage and filtering.
 *
 * This is the core data model for Skygent. Posts are parsed from Bluesky's
 * AT Protocol format and normalized to a consistent structure for querying
 * and filtering. Each post captures the content, metadata, relationships,
 * and engagement metrics from the original Bluesky post.
 *
 * @example
 * ```ts
 * const post = new Post({
 *   uri: "at://did:plc:abc/app.bsky.feed.post/123",
 *   author: "@alice.bsky.social",
 *   text: "Hello, Bluesky! #introduction",
 *   createdAt: "2024-01-15T10:30:00Z",
 *   hashtags: ["introduction"],
 *   mentions: [],
 *   links: []
 * });
 * ```
 */
export class Post extends Schema.Class<Post>("Post")({
  /** The AT Protocol URI uniquely identifying this post */
  uri: PostUri,
  /** The content identifier (CID) of the post record (optional for some contexts) */
  cid: Schema.optional(PostCid),
  /** The author's Bluesky handle (e.g., "@alice.bsky.social") */
  author: Handle,
  /** The author's decentralized identifier (DID) if resolved */
  authorDid: Schema.optional(Did),
  /** The author's profile information including display name and avatar */
  authorProfile: Schema.optional(ProfileBasic),
  /** The full text content of the post */
  text: Schema.String,
  /** ISO timestamp when the post was created */
  createdAt: Timestamp,
  /** Array of hashtags extracted from the post text (without # prefix) */
  hashtags: Schema.Array(Hashtag),
  /** Array of @mentions in the post (without @ prefix) */
  mentions: Schema.Array(Handle),
  /** Array of DIDs corresponding to the mentions if resolved */
  mentionDids: Schema.optional(Schema.Array(Did)),
  /** Array of external URLs extracted from the post */
  links: Schema.Array(Schema.URL),
  /** Rich text facets defining formatting and entity positions */
  facets: Schema.optional(Schema.Array(RichTextFacet)),
  /** Reference to the parent post if this is a reply */
  reply: Schema.optional(ReplyRef),
  /** Embedded media or records (images, videos, external links, quotes) */
  embed: Schema.optional(PostEmbed),
  /** The raw embedded record data for complex embed types */
  recordEmbed: Schema.optional(Schema.Unknown),
  /** Array of language codes for the post content */
  langs: Schema.optional(Schema.Array(Schema.String)),
  /** Array of user-defined tags on the post */
  tags: Schema.optional(Schema.Array(Schema.String)),
  /** Self-applied content labels for moderation */
  selfLabels: Schema.optional(Schema.Array(SelfLabel)),
  /** Moderation labels applied to this post */
  labels: Schema.optional(Schema.Array(Label)),
  /** Engagement metrics (likes, reposts, replies, quotes) */
  metrics: Schema.optional(PostMetrics),
  /** ISO timestamp when the post was indexed by Bluesky */
  indexedAt: Schema.optional(Timestamp),
  /** Viewer-specific state (like/repost status, thread muting) */
  viewer: Schema.optional(PostViewerState),
  /** Thread moderation settings if applied */
  threadgate: Schema.optional(ThreadgateView),
  /** Debug information for development purposes */
  debug: Schema.optional(Schema.Unknown),
  /** Context about how this post was retrieved (timeline, feed, etc.) */
  feed: Schema.optional(FeedContext)
}) {}

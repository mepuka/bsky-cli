/**
 * Bluesky API client service providing authenticated access to AT Protocol APIs.
 *
 * This service wraps the @atproto/api client with Effect-based error handling,
 * automatic retry logic, and rate limiting. It provides a streaming interface
 * for paginated endpoints and supports multiple authentication sources.
 *
 * ## Authentication
 *
 * Credentials are resolved from (in order of priority):
 * 1. Environment variables (BSKY_HANDLE, BSKY_PASSWORD)
 * 2. Credential store (managed via `skygent credentials` commands)
 * 3. Interactive prompts (if TTY available)
 *
 * ## Features
 *
 * - Automatic session refresh and retry on rate limits
 * - Configurable retry policies via AppConfig
 * - Streaming interface for paginated feeds
 * - Type-safe API wrappers
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { BskyClient } from "./services/bsky-client.js";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* BskyClient;
 *
 *   // Stream posts from the authenticated user's timeline
 *   const posts = yield* client.getTimeline({ limit: 100 }).pipe(
 *     Effect.runCollect
 *   );
 *
 *   // Get a specific post
 *   const post = yield* client.getPost("at://did:plc:abc/app.bsky.feed.post/123");
 *
 *   // Search for posts
 *   const searchResults = yield* client.searchPosts("skygent").pipe(
 *     Effect.runCollect
 *   );
 * });
 * ```
 *
 * @module services/bsky-client
 */

import { AtpAgent, AppBskyFeedDefs } from "@atproto/api";
import type {
  AppBskyActorSearchActors,
  AppBskyActorSearchActorsTypeahead,
  AppBskyActorGetProfiles,
  AppBskyFeedGetAuthorFeed,
  AppBskyFeedGetFeed,
  AppBskyFeedGetListFeed,
  AppBskyFeedGetPostThread,
  AppBskyFeedGetPosts,
  AppBskyFeedGetFeedGenerator,
  AppBskyFeedGetFeedGenerators,
  AppBskyFeedGetActorFeeds,
  AppBskyFeedGetLikes,
  AppBskyFeedGetQuotes,
  AppBskyFeedGetRepostedBy,
  AppBskyFeedSearchPosts,
  AppBskyFeedGetTimeline,
  AppBskyFeedPost,
  AppBskyGraphGetBlocks,
  AppBskyGraphGetFollowers,
  AppBskyGraphGetFollows,
  AppBskyGraphGetKnownFollowers,
  AppBskyGraphGetList,
  AppBskyGraphGetLists,
  AppBskyGraphGetMutes,
  AppBskyGraphGetRelationships,
  AppBskyNotificationListNotifications,
  AppBskyUnspeccedGetPopularFeedGenerators,
  AppBskyUnspeccedGetTrendingTopics,
  ComAtprotoIdentityResolveIdentity
} from "@atproto/api";
import {
  Chunk,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream
} from "effect";
import { AppConfigService } from "./app-config.js";
import { CredentialStore } from "./credential-store.js";
import { BskyError } from "../domain/errors.js";
import { RawPost } from "../domain/raw.js";
import {
  BlockedAuthor,
  EmbedAspectRatio,
  EmbedExternal,
  EmbedImage,
  EmbedImages,
  EmbedRecordBlocked,
  EmbedRecordDetached,
  EmbedRecordNotFound,
  EmbedRecordTarget,
  EmbedRecordUnknown,
  EmbedRecordView,
  EmbedRecord,
  EmbedRecordWithMedia,
  EmbedUnknown,
  EmbedVideo,
  isEmbedExternal,
  isEmbedImages,
  isEmbedVideo,
  FeedContext,
  FeedGeneratorView,
  FeedPostBlocked,
  FeedPostNotFound,
  FeedPostUnknown,
  FeedPostViewRef,
  FeedReasonPin,
  FeedReasonRepost,
  FeedReasonUnknown,
  FeedReplyRef,
  IdentityInfo,
  Label,
  ListItemView,
  ListView,
  PostLike,
  AuthorFeedFilter,
  PostEmbed,
  PostMetrics,
  PostViewerState,
  ProfileBasic,
  ProfileView,
  RelationshipView
} from "../domain/bsky.js";
import { Did, PostCid, PostUri, Timestamp } from "../domain/primitives.js";

/**
 * Options for retrieving the user's timeline.
 */
export interface TimelineOptions {
  /** Maximum number of posts to retrieve per page (default: 100) */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for retrieving feed or list posts.
 */
export interface FeedOptions {
  /** Maximum number of posts to retrieve per page (default: 100) */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for graph-related queries (followers, follows, etc.).
 */
export interface GraphOptions {
  /** Maximum number of results per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for retrieving Bluesky lists.
 */
export interface GraphListsOptions {
  /** Maximum number of lists per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
  /** Filter by list purpose ("modlist" or "curatelist") */
  readonly purposes?: ReadonlyArray<"modlist" | "curatelist">;
}

/**
 * Options for retrieving an author's feed.
 */
export interface AuthorFeedOptions {
  /** Maximum number of posts per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
  /** Filter posts by type (posts, posts_and_author_threads, posts_no_replies, posts_with_media, posts_with_video) */
  readonly filter?: AuthorFeedFilter;
  /** Whether to include pinned posts */
  readonly includePins?: boolean;
}

/**
 * Options for retrieving a post thread.
 */
export interface ThreadOptions {
  /** How many levels of replies to fetch (default: 6) */
  readonly depth?: number;
  /** How many levels of parent posts to fetch (default: 6) */
  readonly parentHeight?: number;
}

/**
 * Options for retrieving notifications.
 */
export interface NotificationsOptions {
  /** Maximum number of notifications per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for searching actors (users).
 */
export interface ActorSearchOptions {
  /** Maximum number of results per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
  /** Use typeahead search for faster results */
  readonly typeahead?: boolean;
}

/**
 * Options for searching feeds.
 */
export interface FeedSearchOptions {
  /** Maximum number of results per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for retrieving an actor's feeds.
 */
export interface ActorFeedsOptions {
  /** Maximum number of feeds per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for retrieving engagement data (likes, reposts, quotes).
 */
export interface EngagementOptions {
  /** The post CID to query engagement for */
  readonly cid?: string;
  /** Maximum number of results per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
}

/**
 * Options for searching posts across the Bluesky network.
 */
export interface NetworkSearchOptions {
  /** Maximum number of results per page */
  readonly limit?: number;
  /** Pagination cursor for fetching the next page */
  readonly cursor?: string;
  /** Sort order: "top" for relevance, "latest" for recency */
  readonly sort?: "top" | "latest";
  /** Filter posts after this timestamp (ISO 8601) */
  readonly since?: string;
  /** Filter posts before this timestamp (ISO 8601) */
  readonly until?: string;
  /** Filter posts mentioning this handle */
  readonly mentions?: string;
  /** Filter posts by this author handle */
  readonly author?: string;
  /** Filter posts by language code */
  readonly lang?: string;
  /** Filter posts containing links to this domain */
  readonly domain?: string;
  /** Filter posts containing this URL */
  readonly url?: string;
  /** Filter posts containing all of these hashtags */
  readonly tags?: ReadonlyArray<string>;
}

type FeedViewPost = AppBskyFeedDefs.FeedViewPost;
type PostView = AppBskyFeedDefs.PostView;
type ThreadViewPost = AppBskyFeedDefs.ThreadViewPost;


const extractBskyErrorDetails = (cause: unknown) => {
  if (!cause || typeof cause !== "object") {
    return {} as const;
  }
  const record = cause as {
    status?: unknown;
    statusCode?: unknown;
    error?: unknown;
    message?: unknown;
  };
  const status =
    typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : typeof (record.error as { status?: unknown })?.status === "number"
          ? (record.error as { status: number }).status
          : undefined;
  const error =
    typeof record.error === "string"
      ? record.error
      : typeof (record.error as { message?: unknown })?.message === "string"
        ? (record.error as { message: string }).message
        : undefined;
  const detail =
    typeof record.message === "string"
      ? record.message
      : typeof (record.error as { message?: unknown })?.message === "string"
        ? (record.error as { message: string }).message
        : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(detail !== undefined ? { detail } : {})
  } as const;
};

const formatBskyErrorMessage = (
  fallback: string,
  _cause: unknown,
  details: ReturnType<typeof extractBskyErrorDetails>
) => {
  const status = details.status;
  const summary = typeof status === "number" ? statusSummary(status) : undefined;
  const detail = normalizeDetail(details.detail ?? details.error);

  if (typeof status === "number") {
    const summaryPart = summary ? `: ${summary}` : "";
    const detailPart = detail && detail !== summary ? ` - ${detail}` : "";
    return `${fallback} (HTTP ${status}${summaryPart}${detailPart})`;
  }

  return detail ? `${fallback} (${detail})` : fallback;
};

const statusSummary = (status: number): string | undefined => {
  switch (status) {
    case 400:
      return "Bad request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not found";
    case 409:
      return "Conflict";
    case 413:
      return "Payload too large";
    case 429:
      return "Rate limited";
    case 500:
      return "Server error";
    case 502:
      return "Bad gateway";
    case 503:
      return "Service unavailable";
    case 504:
      return "Gateway timeout";
    default:
      return status >= 500 ? "Server error" : undefined;
  }
};

const normalizeDetail = (detail?: string) => {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
};

const toBskyError = (message: string, operation?: string) => (cause: unknown) => {
  const details = extractBskyErrorDetails(cause);
  return BskyError.make({
    message: formatBskyErrorMessage(message, cause, details),
    cause,
    operation,
    ...details
  });
};

const isRetryableCause = (cause: unknown) => {
  if (!cause || typeof cause !== "object") return false;
  const source =
    "cause" in cause && typeof (cause as { cause?: unknown }).cause !== "undefined"
      ? (cause as { cause?: unknown }).cause
      : cause;
  if (!source || typeof source !== "object") return false;
  const record = source as { status?: unknown; statusCode?: unknown; error?: unknown };
  const status =
    typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : typeof (record.error as { status?: unknown })?.status === "number"
          ? (record.error as { status: number }).status
          : undefined;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status < 600);
  }
  const code = (record as { code?: unknown }).code;
  return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
};

const mapAspectRatio = (input: unknown) => {
  if (!input || typeof input !== "object") return undefined;
  const ratio = input as { width?: unknown; height?: unknown };
  if (typeof ratio.width !== "number" || typeof ratio.height !== "number") {
    return undefined;
  }
  return EmbedAspectRatio.make({ width: ratio.width, height: ratio.height });
};

const decodeTimestamp = (value: unknown, message: string) =>
  Schema.decodeUnknown(Timestamp)(value).pipe(
    Effect.mapError(toBskyError(message))
  );

const decodeDid = (value: unknown, message: string) =>
  Schema.decodeUnknown(Did)(value).pipe(
    Effect.mapError(toBskyError(message))
  );

const decodePostUri = (value: unknown, message: string) =>
  Schema.decodeUnknown(PostUri)(value).pipe(
    Effect.mapError(toBskyError(message))
  );

const decodePostCid = (value: unknown, message: string) =>
  Schema.decodeUnknown(PostCid)(value).pipe(
    Effect.mapError(toBskyError(message))
  );

const decodePostUriOptional = (value: unknown, message: string) =>
  typeof value === "undefined"
    ? Effect.void.pipe(Effect.as(undefined))
    : decodePostUri(value, message);

const decodePostCidOptional = (value: unknown, message: string) =>
  typeof value === "undefined"
    ? Effect.void.pipe(Effect.as(undefined))
    : decodePostCid(value, message);

const decodeLabels = (labels: unknown) =>
  Schema.decodeUnknown(Schema.Array(Label))(labels).pipe(
    Effect.mapError(toBskyError("Invalid moderation labels"))
  );

const decodeProfileBasic = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid author payload" });
    }
    const author = input as Record<string, unknown>;
    return yield* Schema.decodeUnknown(ProfileBasic)({
      did: author.did,
      handle: author.handle,
      displayName: author.displayName,
      pronouns: author.pronouns,
      avatar: author.avatar,
      associated: author.associated,
      viewer: author.viewer,
      labels: author.labels,
      createdAt: author.createdAt,
      verification: author.verification,
      status: author.status,
      debug: author.debug
    }).pipe(Effect.mapError(toBskyError("Invalid author payload")));
  });

const decodeProfileView = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid profile payload" });
    }
    const author = input as Record<string, unknown>;
    return yield* Schema.decodeUnknown(ProfileView)({
      did: author.did,
      handle: author.handle,
      displayName: author.displayName,
      pronouns: author.pronouns,
      description: author.description,
      avatar: author.avatar,
      associated: author.associated,
      indexedAt: author.indexedAt,
      createdAt: author.createdAt,
      viewer: author.viewer,
      labels: author.labels,
      verification: author.verification,
      status: author.status,
      debug: author.debug
    }).pipe(Effect.mapError(toBskyError("Invalid profile payload")));
  });

const decodeIdentityInfo = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid identity payload" });
    }
    const info = input as Record<string, unknown>;
    return yield* Schema.decodeUnknown(IdentityInfo)({
      did: info.did,
      handle: info.handle,
      didDoc: info.didDoc
    }).pipe(Effect.mapError(toBskyError("Invalid identity payload")));
  });

const decodeFeedGeneratorView = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid feed generator payload" });
    }
    const feed = input as Record<string, unknown>;
    const creator = yield* decodeProfileView(feed.creator);
    return yield* Schema.decodeUnknown(FeedGeneratorView)({
      uri: feed.uri,
      cid: feed.cid,
      did: feed.did,
      creator,
      displayName: feed.displayName,
      description: feed.description,
      descriptionFacets: feed.descriptionFacets,
      avatar: feed.avatar,
      likeCount: feed.likeCount,
      acceptsInteractions: feed.acceptsInteractions,
      labels: feed.labels,
      viewer: feed.viewer,
      contentMode: feed.contentMode,
      indexedAt: feed.indexedAt
    }).pipe(Effect.mapError(toBskyError("Invalid feed generator payload")));
  });

const decodeListView = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid list payload" });
    }
    const list = input as Record<string, unknown>;
    const creator = yield* decodeProfileView(list.creator);
    return yield* Schema.decodeUnknown(ListView)({
      uri: list.uri,
      cid: list.cid,
      creator,
      name: list.name,
      purpose: list.purpose,
      description: list.description,
      descriptionFacets: list.descriptionFacets,
      avatar: list.avatar,
      listItemCount: list.listItemCount,
      labels: list.labels,
      viewer: list.viewer,
      indexedAt: list.indexedAt
    }).pipe(Effect.mapError(toBskyError("Invalid list payload")));
  });

const decodeListItemView = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid list item payload" });
    }
    const item = input as Record<string, unknown>;
    const subject = yield* decodeProfileView(item.subject);
    return yield* Schema.decodeUnknown(ListItemView)({
      uri: item.uri,
      subject
    }).pipe(Effect.mapError(toBskyError("Invalid list item payload")));
  });

const decodeRelationshipView = (input: unknown) =>
  Schema.decodeUnknown(RelationshipView)(input).pipe(
    Effect.mapError(toBskyError("Invalid relationship payload"))
  );

const decodePostLike = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid like payload" });
    }
    const like = input as Record<string, unknown>;
    const actor = yield* decodeProfileView(like.actor);
    const createdAt = yield* decodeTimestamp(like.createdAt, "Invalid like timestamp");
    const indexedAt = yield* decodeTimestamp(like.indexedAt, "Invalid like timestamp");
    return yield* Schema.decodeUnknown(PostLike)({
      actor,
      createdAt,
      indexedAt
    }).pipe(Effect.mapError(toBskyError("Invalid like payload")));
  });

const decodeViewerState = (input: unknown) =>
  Schema.decodeUnknown(PostViewerState)(input).pipe(
    Effect.mapError(toBskyError("Invalid viewer state"))
  );

const mapBlockedAuthor = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid blocked author payload" });
    }
    const author = input as Record<string, unknown>;
    return yield* Schema.decodeUnknown(BlockedAuthor)({
      did: author.did,
      viewer: author.viewer
    }).pipe(Effect.mapError(toBskyError("Invalid blocked author payload")));
  });

const mapEmbedRecordTarget = (
  record: unknown
): Effect.Effect<EmbedRecordTarget, BskyError> =>
  Effect.gen(function* () {
    if (!record || typeof record !== "object") {
      return EmbedRecordUnknown.make({ rawType: "unknown", data: record });
    }
    const typed = record as { $type?: string };
    const recordType = typed.$type;
    switch (recordType) {
      case "app.bsky.embed.record#viewRecord": {
        const view = record as {
          uri?: unknown;
          cid?: unknown;
          author?: unknown;
          value?: unknown;
          labels?: unknown;
          replyCount?: unknown;
          repostCount?: unknown;
          likeCount?: unknown;
          quoteCount?: unknown;
          embeds?: unknown;
          indexedAt?: unknown;
        };
        const author = yield* decodeProfileBasic(view.author);
        const labels =
          view.labels && Array.isArray(view.labels)
            ? yield* decodeLabels(view.labels)
            : undefined;
        const metrics = (() => {
          const data = {
            replyCount: view.replyCount as number | undefined,
            repostCount: view.repostCount as number | undefined,
            likeCount: view.likeCount as number | undefined,
            quoteCount: view.quoteCount as number | undefined
          };
          const hasAny = Object.values(data).some((value) => value !== undefined);
          return hasAny ? PostMetrics.make(data) : undefined;
        })();
        const indexedAt = yield* decodeTimestamp(
          view.indexedAt,
          "Invalid record embed timestamp"
        );
        const embeds: Array<PostEmbed> | undefined =
          Array.isArray(view.embeds)
            ? yield* Effect.forEach(
                view.embeds,
                (entry) => mapEmbedView(entry),
                { concurrency: "unbounded" }
              ).pipe(
                Effect.map((values) =>
                  values.filter((value): value is PostEmbed => value !== undefined)
                )
              )
            : undefined;
        return EmbedRecordView.make({
          uri: yield* decodePostUri(
            view.uri,
            "Invalid record embed URI"
          ),
          cid: yield* decodePostCid(
            view.cid,
            "Invalid record embed CID"
          ),
          author,
          value: view.value ?? record,
          labels,
          metrics,
          embeds,
          indexedAt
        });
      }
      case "app.bsky.embed.record#viewNotFound":
        return EmbedRecordNotFound.make({
          uri: yield* decodePostUri(
            (record as { uri?: unknown }).uri,
            "Invalid record embed URI"
          ),
          notFound: true
        });
      case "app.bsky.embed.record#viewBlocked": {
        const author = yield* mapBlockedAuthor(
          (record as { author?: unknown }).author
        );
        return EmbedRecordBlocked.make({
          uri: yield* decodePostUri(
            (record as { uri?: unknown }).uri,
            "Invalid record embed URI"
          ),
          blocked: true,
          author
        });
      }
      case "app.bsky.embed.record#viewDetached":
        return EmbedRecordDetached.make({
          uri: yield* decodePostUri(
            (record as { uri?: unknown }).uri,
            "Invalid record embed URI"
          ),
          detached: true
        });
      default:
        return EmbedRecordUnknown.make({
          rawType: typeof recordType === "string" ? recordType : "unknown",
          data: record
        });
    }
  });

const mapEmbedView = (
  embed: unknown
): Effect.Effect<PostEmbed | undefined, BskyError> =>
  Effect.gen(function* () {
    if (!embed || typeof embed !== "object") return undefined;
    const typed = embed as { $type?: string };
    switch (typed.$type) {
      case "app.bsky.embed.images#view": {
        const images = (embed as { images?: Array<any> }).images ?? [];
        return EmbedImages.make({
          images: images
            .filter((image) => image && typeof image === "object")
            .map((image) =>
              EmbedImage.make({
                thumb: String(image.thumb ?? ""),
                fullsize: String(image.fullsize ?? ""),
                alt: String(image.alt ?? ""),
                aspectRatio: mapAspectRatio(image.aspectRatio)
              })
            )
        });
      }
      case "app.bsky.embed.external#view": {
        const external = (embed as { external?: any }).external ?? {};
        return EmbedExternal.make({
          uri: String(external.uri ?? ""),
          title: String(external.title ?? ""),
          description: String(external.description ?? ""),
          thumb: external.thumb ? String(external.thumb) : undefined
        });
      }
      case "app.bsky.embed.video#view": {
        return EmbedVideo.make({
          cid: String((embed as { cid?: unknown }).cid ?? ""),
          playlist: String((embed as { playlist?: unknown }).playlist ?? ""),
          thumbnail: (embed as { thumbnail?: unknown }).thumbnail
            ? String((embed as { thumbnail?: unknown }).thumbnail)
            : undefined,
          alt: (embed as { alt?: unknown }).alt
            ? String((embed as { alt?: unknown }).alt)
            : undefined,
          aspectRatio: mapAspectRatio((embed as { aspectRatio?: unknown }).aspectRatio)
        });
      }
      case "app.bsky.embed.record#view": {
        const record = (embed as { record?: unknown }).record;
        const recordType = record && typeof record === "object" ? (record as { $type?: string }).$type : undefined;
        const mapped = yield* mapEmbedRecordTarget(record ?? embed);
        return EmbedRecord.make({
          recordType,
          record: mapped
        });
      }
      case "app.bsky.embed.recordWithMedia#view": {
        const record = (embed as { record?: unknown }).record;
        const recordType = record && typeof record === "object" ? (record as { $type?: string }).$type : undefined;
        const mediaCandidate: PostEmbed | undefined = yield* mapEmbedView(
          (embed as { media?: unknown }).media
        );
        const media: PostEmbed | unknown =
          mediaCandidate &&
          (isEmbedImages(mediaCandidate) ||
            isEmbedExternal(mediaCandidate) ||
            isEmbedVideo(mediaCandidate))
            ? mediaCandidate
            : (embed as { media?: unknown }).media;
        const mapped: EmbedRecordTarget = yield* mapEmbedRecordTarget(record ?? embed);
        return EmbedRecordWithMedia.make({
          recordType,
          record: mapped,
          media
        });
      }
      default:
        if (typed.$type) {
          return EmbedUnknown.make({ rawType: typed.$type, data: embed });
        }
        return undefined;
    }
  });

const metricsFromPostView = (post: PostView) => {
  const data = {
    replyCount: post.replyCount,
    repostCount: post.repostCount,
    likeCount: post.likeCount,
    quoteCount: post.quoteCount,
    bookmarkCount: post.bookmarkCount
  };
  const hasAny = Object.values(data).some((value) => value !== undefined);
  return hasAny ? PostMetrics.make(data) : undefined;
};

const mapFeedPostReference = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return FeedPostUnknown.make({ rawType: "unknown", data: input });
    }
    const candidate = input as {
      $type?: unknown;
      uri?: unknown;
      cid?: unknown;
      author?: unknown;
      notFound?: unknown;
      blocked?: unknown;
    };
    const type = typeof candidate.$type === "string" ? candidate.$type : undefined;
    if (
      type === "app.bsky.feed.defs#postView" ||
      (candidate.uri && candidate.cid && candidate.author)
    ) {
      const post = input as PostView;
      const author = yield* decodeProfileBasic(post.author);
      const labels =
        post.labels && post.labels.length > 0
          ? yield* decodeLabels(post.labels)
          : undefined;
      const viewer = post.viewer ? yield* decodeViewerState(post.viewer) : undefined;
      const indexedAt = yield* decodeTimestamp(
        post.indexedAt,
        "Invalid feed post timestamp"
      );
      return FeedPostViewRef.make({
        uri: yield* decodePostUri(
          post.uri,
          "Invalid feed post URI"
        ),
        cid: yield* decodePostCid(
          post.cid,
          "Invalid feed post CID"
        ),
        author,
        indexedAt,
        labels,
        viewer
      });
    }
    if (type === "app.bsky.feed.defs#notFoundPost" || candidate.notFound === true) {
      return FeedPostNotFound.make({
        uri: yield* decodePostUri(
          candidate.uri,
          "Invalid feed post URI"
        ),
        notFound: true
      });
    }
    if (type === "app.bsky.feed.defs#blockedPost" || candidate.blocked === true) {
      const author = yield* mapBlockedAuthor(
        (candidate as { author?: unknown }).author
      );
      return FeedPostBlocked.make({
        uri: yield* decodePostUri(
          candidate.uri,
          "Invalid feed post URI"
        ),
        blocked: true,
        author
      });
    }
    return FeedPostUnknown.make({
      rawType: type ?? "unknown",
      data: input
    });
  });

const mapFeedReplyRef = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return yield* BskyError.make({ message: "Invalid feed reply payload" });
    }
    const reply = input as {
      root?: unknown;
      parent?: unknown;
      grandparentAuthor?: unknown;
    };
    const root = yield* mapFeedPostReference(reply.root);
    const parent = yield* mapFeedPostReference(reply.parent);
    const grandparentAuthor = reply.grandparentAuthor
      ? yield* decodeProfileBasic(reply.grandparentAuthor)
      : undefined;
    return FeedReplyRef.make({
      root,
      parent,
      grandparentAuthor
    });
  });

const mapFeedReason = (input: unknown) =>
  Effect.gen(function* () {
    if (!input || typeof input !== "object") {
      return FeedReasonUnknown.make({ rawType: "unknown", data: input });
    }
    const reason = input as { $type?: unknown };
    const type = typeof reason.$type === "string" ? reason.$type : undefined;
    switch (type) {
      case "app.bsky.feed.defs#reasonRepost": {
        const raw = reason as {
          by?: unknown;
          uri?: unknown;
          cid?: unknown;
          indexedAt?: unknown;
        };
        const by = yield* decodeProfileBasic(raw.by);
        const indexedAt = yield* decodeTimestamp(
          raw.indexedAt,
          "Invalid reason timestamp"
        );
        return FeedReasonRepost.make({
          by,
          uri: yield* decodePostUriOptional(
            raw.uri,
            "Invalid repost URI"
          ),
          cid: yield* decodePostCidOptional(
            raw.cid,
            "Invalid repost CID"
          ),
          indexedAt
        });
      }
      case "app.bsky.feed.defs#reasonPin":
        return FeedReasonPin.make({});
      default:
        return FeedReasonUnknown.make({
          rawType: type ?? "unknown",
          data: input
        });
    }
  });

const mapFeedContext = (item: FeedViewPost) =>
  Effect.gen(function* () {
    const reply = item.reply ? yield* mapFeedReplyRef(item.reply) : undefined;
    const reason = item.reason ? yield* mapFeedReason(item.reason) : undefined;
    return yield* Schema.decodeUnknown(FeedContext)({
      reply,
      reason,
      feedContext: item.feedContext,
      reqId: item.reqId
    }).pipe(Effect.mapError(toBskyError("Invalid feed context payload")));
  });

const withCursor = <T extends Record<string, unknown>>(
  params: T,
  cursor: string | undefined
): T & { cursor?: string } =>
  typeof cursor === "string" ? { ...params, cursor } : params;

const toRawPost = (post: PostView, feed?: FeedContext) =>
  Effect.gen(function* () {
    const embed = yield* mapEmbedView(post.embed);
    const authorProfile = yield* decodeProfileBasic(post.author);
    const raw = {
      uri: post.uri,
      cid: post.cid,
      author: post.author.handle,
      authorDid: post.author.did,
      authorProfile,
      record: post.record,
      indexedAt: post.indexedAt,
      labels: post.labels,
      metrics: metricsFromPostView(post),
      embed,
      viewer: post.viewer,
      threadgate: post.threadgate,
      debug: post.debug,
      feed
    };

    return yield* Schema.decodeUnknown(RawPost)(raw).pipe(
      Effect.mapError(toBskyError("Invalid post payload"))
    );
  });

const toRawPostsFromFeed = (feed: ReadonlyArray<FeedViewPost>) =>
  Effect.partition(feed, (item, index) =>
    Effect.gen(function* () {
      const context = yield* mapFeedContext(item);
      return yield* toRawPost(item.post, context);
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Skipping malformed feed item at index ${index}`, {
          uri: item.post?.uri,
          error: error.message
        })
      )
    )
  ).pipe(
    Effect.tap(([errors, successes]) => {
      if (errors.length > 0) {
        return Effect.log(
          `Feed sync: processed ${successes.length} posts, skipped ${errors.length} malformed items`
        );
      }
      return Effect.void;
    }),
    Effect.map(([_, successes]) => successes)
  );

const chunkArray = <A>(
  items: ReadonlyArray<A>,
  size: number
): Array<Array<A>> => {
  if (items.length === 0) return [];
  const chunkSize = Math.max(1, Math.trunc(size));
  const chunks: Array<Array<A>> = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
};

const isPostRecord = (record: unknown): record is AppBskyFeedPost.Record =>
  typeof record === "object" &&
  record !== null &&
  (record as { $type?: unknown }).$type === "app.bsky.feed.post";

const collectThreadChildren = (node: ThreadViewPost): ReadonlyArray<ThreadViewPost> => {
  const items: Array<ThreadViewPost> = [];
  const parent = node.parent;
  if (parent && AppBskyFeedDefs.isThreadViewPost(parent)) {
    items.push(parent);
  }
  if (Array.isArray(node.replies)) {
    for (const reply of node.replies) {
      if (AppBskyFeedDefs.isThreadViewPost(reply)) {
        items.push(reply);
      }
    }
  }
  return items;
};

const unfoldThread = (root: ThreadViewPost) =>
  Stream.unfoldEffect(
    { queue: [root] as ReadonlyArray<ThreadViewPost>, seen: new Set<string>() },
    (state) =>
      Effect.sync(() => {
        const queue = state.queue.slice();
        while (queue.length > 0) {
          const next = queue.shift()!;
          const nextUri = next.post?.uri;
          const children = collectThreadChildren(next);
          queue.push(...children);
          if (typeof nextUri === "string") {
            if (state.seen.has(nextUri)) {
              continue;
            }
            state.seen.add(nextUri);
          }
          return Option.some([next, { queue, seen: state.seen }] as const);
        }
        return Option.none();
      })
  );

const toRawPostsFromThread = (root: ThreadViewPost) =>
  unfoldThread(root).pipe(
    Stream.mapEffect((node) => toRawPost(node.post)),
    Stream.runCollect,
    Effect.map(Chunk.toReadonlyArray)
  );

/**
 * Service for interacting with the Bluesky (AT Protocol) API.
 *
 * Provides authenticated access to all major Bluesky API endpoints including:
 * - Timeline and feed retrieval
 * - Post search and discovery
 * - Social graph operations (followers, follows, lists)
 * - Engagement data (likes, reposts, quotes)
 * - Notifications
 * - Thread viewing
 *
 * ## Authentication
 *
 * The client automatically handles authentication using credentials resolved
 * from environment variables, credential store, or interactive prompts.
 *
 * ## Error Handling
 *
 * All methods return Effect values that can fail with `BskyError`. Common
 * error scenarios include:
 * - Network failures (automatically retried)
 * - Rate limiting (automatically retried with backoff)
 * - Authentication errors
 * - Invalid post/feed URIs
 *
 * ## Streaming
 *
 * Paginated endpoints (timeline, feeds, search) return `Stream.Stream` values
 * that automatically handle pagination. Use `Effect.runCollect` to gather
 * all results or process them incrementally.
 *
 * @example
 * ```ts
 * import { Effect, Stream } from "effect";
 * import { BskyClient } from "./services/bsky-client.js";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* BskyClient;
 *
 *   // Get timeline as a stream
 *   const timelineStream = client.getTimeline({ limit: 100 });
 *
 *   // Collect all posts
 *   const allPosts = yield* timelineStream.pipe(Stream.runCollect);
 *
 *   // Get a specific post
 *   const post = yield* client.getPost("at://did:plc:abc/app.bsky.feed.post/123");
 *
 *   // Search for posts
 *   const results = yield* client.searchPosts("typescript", {
 *     sort: "latest",
 *     limit: 50
 *   }).pipe(Stream.runCollect);
 * });
 * ```
 */
export class BskyClient extends Context.Tag("@skygent/BskyClient")<
  BskyClient,
  {
    /**
     * Get the authenticated user's home timeline.
     *
     * Returns a stream of posts from followed accounts.
     *
     * @param opts - Pagination options
     * @returns Stream of posts from the timeline
     */
    readonly getTimeline: (opts?: TimelineOptions) => Stream.Stream<RawPost, BskyError>;
    readonly getNotifications: (
      opts?: NotificationsOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getFeed: (
      uri: string,
      opts?: FeedOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getListFeed: (
      uri: string,
      opts?: FeedOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getAuthorFeed: (
      actor: string,
      opts?: AuthorFeedOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getPost: (uri: string) => Effect.Effect<RawPost, BskyError>;
    readonly getPostThread: (
      uri: string,
      opts?: ThreadOptions
    ) => Effect.Effect<ReadonlyArray<RawPost>, BskyError>;
    readonly getFollowers: (
      actor: string,
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly subject: ProfileView; readonly followers: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getFollows: (
      actor: string,
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly subject: ProfileView; readonly follows: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getKnownFollowers: (
      actor: string,
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly subject: ProfileView; readonly followers: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getRelationships: (
      actor: string,
      others: ReadonlyArray<string>
    ) => Effect.Effect<{ readonly actor: string; readonly relationships: ReadonlyArray<RelationshipView> }, BskyError>;
    readonly getList: (
      uri: string,
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly list: ListView; readonly items: ReadonlyArray<ListItemView>; readonly cursor?: string }, BskyError>;
    readonly getLists: (
      actor: string,
      opts?: GraphListsOptions
    ) => Effect.Effect<{ readonly lists: ReadonlyArray<ListView>; readonly cursor?: string }, BskyError>;
    readonly getBlocks: (
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly blocks: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getMutes: (
      opts?: GraphOptions
    ) => Effect.Effect<{ readonly mutes: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getFeedGenerator: (
      uri: string
    ) => Effect.Effect<{ readonly view: FeedGeneratorView; readonly isOnline: boolean; readonly isValid: boolean }, BskyError>;
    readonly getFeedGenerators: (
      uris: ReadonlyArray<string>
    ) => Effect.Effect<{ readonly feeds: ReadonlyArray<FeedGeneratorView> }, BskyError>;
    readonly getActorFeeds: (
      actor: string,
      opts?: ActorFeedsOptions
    ) => Effect.Effect<{ readonly feeds: ReadonlyArray<FeedGeneratorView>; readonly cursor?: string }, BskyError>;
    readonly getLikes: (
      uri: string,
      opts?: EngagementOptions
    ) => Effect.Effect<{ readonly uri: string; readonly cid?: string; readonly likes: ReadonlyArray<PostLike>; readonly cursor?: string }, BskyError>;
    readonly getRepostedBy: (
      uri: string,
      opts?: EngagementOptions
    ) => Effect.Effect<{ readonly uri: string; readonly cid?: string; readonly repostedBy: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly getQuotes: (
      uri: string,
      opts?: EngagementOptions
    ) => Effect.Effect<{ readonly uri: string; readonly cid?: string; readonly posts: ReadonlyArray<RawPost>; readonly cursor?: string }, BskyError>;
    readonly resolveHandle: (handle: string) => Effect.Effect<Did, BskyError>;
    readonly resolveIdentity: (
      identifier: string
    ) => Effect.Effect<IdentityInfo, BskyError>;
    readonly getProfiles: (
      actors: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<ProfileBasic>, BskyError>;
    readonly searchActors: (
      query: string,
      opts?: ActorSearchOptions
    ) => Effect.Effect<{ readonly actors: ReadonlyArray<ProfileView>; readonly cursor?: string }, BskyError>;
    readonly searchFeedGenerators: (
      query: string,
      opts?: FeedSearchOptions
    ) => Effect.Effect<{ readonly feeds: ReadonlyArray<FeedGeneratorView>; readonly cursor?: string }, BskyError>;
    readonly searchPosts: (
      query: string,
      opts?: NetworkSearchOptions
    ) => Effect.Effect<{ readonly posts: ReadonlyArray<RawPost>; readonly cursor?: string; readonly hitsTotal?: number }, BskyError>;
    readonly getTrendingTopics: () => Effect.Effect<ReadonlyArray<string>, BskyError>;
  }
>() {
  static readonly layer = Layer.effect(
    BskyClient,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const serviceUrl = yield* Effect.try({
        try: () => new URL(config.service),
        catch: (cause) =>
          BskyError.make({
            message: `Invalid Bluesky service URL: ${config.service}`,
            cause
          })
      });
      if (serviceUrl.protocol !== "https:") {
        return yield* BskyError.make({
          message: "Bluesky service URL must use https."
        });
      }
      const credentials = yield* CredentialStore;
      const agent = new AtpAgent({ service: config.service });
      const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });

      const minInterval = yield* Config.duration("SKYGENT_BSKY_RATE_LIMIT").pipe(
        Config.withDefault(Duration.millis(250))
      );
      const retryBase = yield* Config.duration("SKYGENT_BSKY_RETRY_BASE").pipe(
        Config.withDefault(Duration.millis(250))
      );
      const retryMax = yield* Config.integer("SKYGENT_BSKY_RETRY_MAX").pipe(
        Config.withDefault(5)
      );

      const limiter = yield* Effect.makeSemaphore(1);
      const lastCallRef = yield* Ref.make(0);
      const minIntervalMs = Duration.toMillis(minInterval);

      const withRateLimit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        limiter.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const last = yield* Ref.get(lastCallRef);
            const waitMs = Math.max(0, minIntervalMs - (now - last));
            if (waitMs > 0) {
              yield* Effect.sleep(Duration.millis(waitMs));
            }
            return yield* effect;
          }).pipe(
            Effect.ensuring(
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => Ref.set(lastCallRef, now))
              )
            )
          )
        );

      const retrySchedule = Schedule.exponential(retryBase).pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurWhile(isRetryableCause)),
        Schedule.intersect(Schedule.recurs(retryMax))
      );

      const withRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.retry(retrySchedule));

      const ensureAuth = (required: boolean) =>
        Effect.gen(function* () {
          if (agent.hasSession) {
            return;
          }
          const creds = yield* credentials
            .get()
            .pipe(Effect.mapError(toBskyError("Failed to load credentials", "loadCredentials")));
          if (Option.isNone(creds)) {
            if (required) {
              return yield* BskyError.make({
                message:
                  "Missing Bluesky credentials. Provide identifier and password."
              });
            }
            return;
          }
          const value = creds.value;
          yield* withRetry(
            withRateLimit(
              Effect.tryPromise(() =>
                agent.login({
                  identifier: value.identifier,
                  password: Redacted.value(value.password)
                })
              )
            )
          ).pipe(Effect.mapError(toBskyError("Bluesky login failed", "login")));
        });

      const paginate = <A>(
        initialCursor: string | undefined,
        fetch: (cursor: string | undefined) => Effect.Effect<
          readonly [Chunk.Chunk<A>, Option.Option<string>],
          BskyError
        >
      ) => Stream.paginateChunkEffect(initialCursor, fetch);

      const getTimeline = (opts?: TimelineOptions) =>
        paginate(opts?.cursor, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(true);
            const params = withCursor(
              { limit: opts?.limit ?? 50 },
              cursor
            );
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyFeedGetTimeline.Response>(() =>
                  agent.app.bsky.feed.getTimeline(params)
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to fetch timeline", "getTimeline")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const tagged = posts.map((p) => new RawPost({ ...p, _pageCursor: nextCursor }));
            const hasNext =
              tagged.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(tagged),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getFeed = (uri: string, opts?: FeedOptions) =>
        paginate(opts?.cursor, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(false);
            const params = withCursor(
              { feed: uri, limit: opts?.limit ?? 50 },
              cursor
            );
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyFeedGetFeed.Response>(() =>
                  agent.app.bsky.feed.getFeed(params)
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to fetch feed", "getFeed")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const tagged = posts.map((p) => new RawPost({ ...p, _pageCursor: nextCursor }));
            const hasNext =
              tagged.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(tagged),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getListFeed = (uri: string, opts?: FeedOptions) =>
        paginate(opts?.cursor, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(false);
            const params = withCursor(
              { list: uri, limit: opts?.limit ?? 50 },
              cursor
            );
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyFeedGetListFeed.Response>(() =>
                  agent.app.bsky.feed.getListFeed(params)
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to fetch list feed", "getListFeed")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const tagged = posts.map((p) => new RawPost({ ...p, _pageCursor: nextCursor }));
            const hasNext =
              tagged.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(tagged),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getAuthorFeed = (actor: string, opts?: AuthorFeedOptions) =>
        paginate(opts?.cursor, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(false);
            const includePins = opts?.includePins;
            const params = withCursor(
              {
                actor,
                limit: opts?.limit ?? 50,
                ...(opts?.filter ? { filter: opts.filter } : {}),
                ...(includePins !== undefined ? { includePins } : {})
              },
              cursor
            );
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyFeedGetAuthorFeed.Response>(() =>
                  agent.app.bsky.feed.getAuthorFeed(params)
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to fetch author feed", "getAuthorFeed")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const tagged = posts.map((p) => new RawPost({ ...p, _pageCursor: nextCursor }));
            const hasNext =
              tagged.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(tagged),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getPost = (uri: string) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetPosts.Response>(() =>
                agent.app.bsky.feed.getPosts({ uris: [uri] })
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch post", "getPosts")));
          const postView = response.data.posts[0];
          if (!postView) {
            return yield* BskyError.make({
              message: "Post not found",
              cause: uri
            });
          }
          return yield* toRawPost(postView);
        });

      const getPostThread = (uri: string, opts?: ThreadOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = {
            uri,
            ...(opts?.depth !== undefined ? { depth: opts.depth } : {}),
            ...(opts?.parentHeight !== undefined
              ? { parentHeight: opts.parentHeight }
              : {})
          };
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetPostThread.Response>(() =>
                agent.app.bsky.feed.getPostThread(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch post thread", "getPostThread")));

          if (!AppBskyFeedDefs.isThreadViewPost(response.data.thread)) {
            return [] as ReadonlyArray<RawPost>;
          }

          return yield* toRawPostsFromThread(response.data.thread);
        });

      const getFollowers = (actor: string, opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const api = agent.hasSession ? agent : publicAgent;
          const params = withCursor(
            { actor, limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetFollowers.Response>(() =>
                api.app.bsky.graph.getFollowers(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch followers", "getFollowers")));
          const subject = yield* decodeProfileView(response.data.subject);
          const followers = yield* Effect.forEach(
            response.data.followers,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { subject, followers, cursor } : { subject, followers };
        });

      const getFollows = (actor: string, opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const api = agent.hasSession ? agent : publicAgent;
          const params = withCursor(
            { actor, limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetFollows.Response>(() =>
                api.app.bsky.graph.getFollows(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch follows", "getFollows")));
          const subject = yield* decodeProfileView(response.data.subject);
          const follows = yield* Effect.forEach(
            response.data.follows,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { subject, follows, cursor } : { subject, follows };
        });

      const getKnownFollowers = (actor: string, opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(true);
          const params = withCursor(
            { actor, limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetKnownFollowers.Response>(() =>
                agent.app.bsky.graph.getKnownFollowers(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch known followers", "getKnownFollowers")));
          const subject = yield* decodeProfileView(response.data.subject);
          const followers = yield* Effect.forEach(
            response.data.followers,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { subject, followers, cursor } : { subject, followers };
        });

      const getRelationships = (actor: string, others: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (others.length === 0) {
            return { actor, relationships: [] };
          }
          yield* ensureAuth(false);
          const api = agent.hasSession ? agent : publicAgent;
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetRelationships.Response>(() =>
                api.app.bsky.graph.getRelationships({ actor, others: [...others] })
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch relationships", "getRelationships")));
          const relationships = yield* Effect.forEach(
            response.data.relationships,
            decodeRelationshipView,
            { concurrency: "unbounded" }
          );
          const actorDid =
            typeof response.data.actor === "string" ? response.data.actor : actor;
          return { actor: actorDid, relationships };
        });

      const getList = (uri: string, opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const api = agent.hasSession ? agent : publicAgent;
          const params = withCursor(
            { list: uri, limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetList.Response>(() =>
                api.app.bsky.graph.getList(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch list", "getList")));
          const list = yield* decodeListView(response.data.list);
          const items = yield* Effect.forEach(
            response.data.items,
            decodeListItemView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { list, items, cursor } : { list, items };
        });

      const getLists = (actor: string, opts?: GraphListsOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const api = agent.hasSession ? agent : publicAgent;
          const params = withCursor(
            {
              actor,
              limit: opts?.limit ?? 50,
              ...(opts?.purposes && opts.purposes.length > 0
                ? { purposes: [...opts.purposes] }
                : {})
            },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetLists.Response>(() =>
                api.app.bsky.graph.getLists(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch lists", "getLists")));
          const lists = yield* Effect.forEach(
            response.data.lists,
            decodeListView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { lists, cursor } : { lists };
        });

      const getBlocks = (opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(true);
          const params = withCursor(
            { limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetBlocks.Response>(() =>
                agent.app.bsky.graph.getBlocks(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch blocks", "getBlocks")));
          const blocks = yield* Effect.forEach(
            response.data.blocks,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { blocks, cursor } : { blocks };
        });

      const getMutes = (opts?: GraphOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(true);
          const params = withCursor(
            { limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyGraphGetMutes.Response>(() =>
                agent.app.bsky.graph.getMutes(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch mutes", "getMutes")));
          const mutes = yield* Effect.forEach(
            response.data.mutes,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { mutes, cursor } : { mutes };
        });

      const getFeedGenerator = (uri: string) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetFeedGenerator.Response>(() =>
                agent.app.bsky.feed.getFeedGenerator({ feed: uri })
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch feed generator", "getFeedGenerator")));
          const view = yield* decodeFeedGeneratorView(response.data.view);
          return {
            view,
            isOnline: response.data.isOnline,
            isValid: response.data.isValid
          };
        });

      const getFeedGenerators = (uris: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          if (uris.length === 0) {
            return { feeds: [] as ReadonlyArray<FeedGeneratorView> };
          }
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetFeedGenerators.Response>(() =>
                agent.app.bsky.feed.getFeedGenerators({ feeds: [...uris] })
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch feed generators", "getFeedGenerators")));
          const feeds = yield* Effect.forEach(
            response.data.feeds,
            decodeFeedGeneratorView,
            { concurrency: "unbounded" }
          );
          return { feeds };
        });

      const getActorFeeds = (actor: string, opts?: ActorFeedsOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = withCursor(
            { actor, limit: opts?.limit ?? 50 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetActorFeeds.Response>(() =>
                agent.app.bsky.feed.getActorFeeds(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch actor feeds", "getActorFeeds")));
          const feeds = yield* Effect.forEach(
            response.data.feeds,
            decodeFeedGeneratorView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { feeds, cursor } : { feeds };
        });

      const getLikes = (uri: string, opts?: EngagementOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = withCursor(
            { uri, limit: opts?.limit ?? 50, ...(opts?.cid ? { cid: opts.cid } : {}) },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetLikes.Response>(() =>
                agent.app.bsky.feed.getLikes(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch likes", "getLikes")));
          const likes = yield* Effect.forEach(
            response.data.likes,
            decodePostLike,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return {
            uri: response.data.uri,
            ...(typeof response.data.cid === "string" ? { cid: response.data.cid } : {}),
            likes,
            ...(cursor ? { cursor } : {})
          };
        });

      const getRepostedBy = (uri: string, opts?: EngagementOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = withCursor(
            { uri, limit: opts?.limit ?? 50, ...(opts?.cid ? { cid: opts.cid } : {}) },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetRepostedBy.Response>(() =>
                agent.app.bsky.feed.getRepostedBy(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch reposts", "getRepostedBy")));
          const repostedBy = yield* Effect.forEach(
            response.data.repostedBy,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return {
            uri: response.data.uri,
            ...(typeof response.data.cid === "string" ? { cid: response.data.cid } : {}),
            repostedBy,
            ...(cursor ? { cursor } : {})
          };
        });

      const getQuotes = (uri: string, opts?: EngagementOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = withCursor(
            { uri, limit: opts?.limit ?? 50, ...(opts?.cid ? { cid: opts.cid } : {}) },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedGetQuotes.Response>(() =>
                agent.app.bsky.feed.getQuotes(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to fetch quotes", "getQuotes")));
          const posts = yield* Effect.forEach(
            response.data.posts,
            (post) => toRawPost(post),
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return {
            uri: response.data.uri,
            ...(typeof response.data.cid === "string" ? { cid: response.data.cid } : {}),
            posts,
            ...(cursor ? { cursor } : {})
          };
        });

      const resolveHandle = (handle: string) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise(() => agent.resolveHandle({ handle }))
            )
          ).pipe(Effect.mapError(toBskyError("Failed to resolve handle", "resolveHandle")));
          return yield* decodeDid(response.data.did, "Invalid DID from resolveHandle");
        });

      const resolveIdentity = (identifier: string) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<ComAtprotoIdentityResolveIdentity.Response>(() =>
                agent.com.atproto.identity.resolveIdentity({ identifier })
              )
            )
          ).pipe(
            Effect.mapError(toBskyError("Failed to resolve identity", "resolveIdentity"))
          );
          return yield* decodeIdentityInfo(response.data);
        });

      const getProfiles = (actors: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const uniqueActors = Array.from(new Set(actors));
          if (uniqueActors.length === 0) {
            return [];
          }
          yield* ensureAuth(false);
          const batches = chunkArray(uniqueActors, 25);
          const results = yield* Effect.forEach(
            batches,
            (batch) =>
              withRetry(
                withRateLimit(
                  Effect.tryPromise<AppBskyActorGetProfiles.Response>(() =>
                    agent.app.bsky.actor.getProfiles({ actors: batch })
                  )
                )
              ).pipe(
                Effect.mapError(toBskyError("Failed to fetch profiles", "getProfiles")),
                Effect.flatMap((response) =>
                  Effect.forEach(response.data.profiles, decodeProfileBasic, {
                    concurrency: "unbounded"
                  })
                )
              ),
            { concurrency: "unbounded" }
          );
          return results.flat();
        });

      const searchActors = (query: string, opts?: ActorSearchOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          if (opts?.typeahead) {
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyActorSearchActorsTypeahead.Response>(() =>
                  agent.app.bsky.actor.searchActorsTypeahead({
                    q: query,
                    limit: opts.limit ?? 10
                  })
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to search actors", "searchActorsTypeahead")));
            const actors = yield* Effect.forEach(
              response.data.actors,
              decodeProfileView,
              { concurrency: "unbounded" }
            );
            return { actors };
          }

          const params = withCursor(
            { q: query, limit: opts?.limit ?? 25 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyActorSearchActors.Response>(() =>
                agent.app.bsky.actor.searchActors(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to search actors", "searchActors")));
          const actors = yield* Effect.forEach(
            response.data.actors,
            decodeProfileView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { actors, cursor } : { actors };
        });

      const searchFeedGenerators = (query: string, opts?: FeedSearchOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = withCursor(
            { query, limit: opts?.limit ?? 25 },
            opts?.cursor
          );
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyUnspeccedGetPopularFeedGenerators.Response>(() =>
                agent.app.bsky.unspecced.getPopularFeedGenerators(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to search feed generators", "searchFeedGenerators")));
          const feeds = yield* Effect.forEach(
            response.data.feeds,
            decodeFeedGeneratorView,
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          return cursor ? { feeds, cursor } : { feeds };
        });

      const searchPosts = (query: string, opts?: NetworkSearchOptions) =>
        Effect.gen(function* () {
          yield* ensureAuth(false);
          const params = {
            q: query,
            ...(opts?.sort ? { sort: opts.sort } : {}),
            ...(opts?.since ? { since: opts.since } : {}),
            ...(opts?.until ? { until: opts.until } : {}),
            ...(opts?.mentions ? { mentions: opts.mentions } : {}),
            ...(opts?.author ? { author: opts.author } : {}),
            ...(opts?.lang ? { lang: opts.lang } : {}),
            ...(opts?.domain ? { domain: opts.domain } : {}),
            ...(opts?.url ? { url: opts.url } : {}),
            ...(opts?.tags && opts.tags.length > 0 ? { tag: [...opts.tags] } : {}),
            limit: opts?.limit ?? 25,
            ...(opts?.cursor ? { cursor: opts.cursor } : {})
          };
          const response = yield* withRetry(
            withRateLimit(
              Effect.tryPromise<AppBskyFeedSearchPosts.Response>(() =>
                agent.app.bsky.feed.searchPosts(params)
              )
            )
          ).pipe(Effect.mapError(toBskyError("Failed to search posts", "searchPosts")));
          const posts = yield* Effect.forEach(
            response.data.posts,
            (post) => toRawPost(post),
            { concurrency: "unbounded" }
          );
          const cursor = response.data.cursor;
          const hitsTotal = response.data.hitsTotal;
          return {
            posts,
            ...(typeof cursor === "string" ? { cursor } : {}),
            ...(typeof hitsTotal === "number" ? { hitsTotal } : {})
          };
        });

      const getNotifications = (opts?: NotificationsOptions) =>
        paginate(opts?.cursor, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(true);
            const params = withCursor({ limit: opts?.limit ?? 50 }, cursor);
            const response = yield* withRetry(
              withRateLimit(
                Effect.tryPromise<AppBskyNotificationListNotifications.Response>(() =>
                  agent.app.bsky.notification.listNotifications(params)
                )
              )
            ).pipe(Effect.mapError(toBskyError("Failed to fetch notifications", "listNotifications")));

              const posts = yield* Effect.forEach(
                response.data.notifications,
                (notification) =>
                  Effect.gen(function* () {
                    if (!isPostRecord(notification.record)) {
                      return Option.none<RawPost>();
                    }
                    const raw = {
                      uri: notification.uri,
                      cid: notification.cid,
                      author: notification.author.handle,
                      authorDid: notification.author.did,
                      record: notification.record,
                      indexedAt: notification.indexedAt,
                      labels: notification.labels
                    };
                    const parsed = yield* Schema.decodeUnknown(RawPost)(raw).pipe(
                      Effect.mapError(toBskyError("Invalid notification payload"))
                    );
                    return Option.some(parsed);
                  })
              );

              const filtered = posts.flatMap((item) =>
                Option.isSome(item) ? [item.value] : []
              );
            const nextCursor = response.data.cursor;
            const tagged = filtered.map((p) => new RawPost({ ...p, _pageCursor: nextCursor }));
            const hasNext =
              tagged.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(tagged),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getTrendingTopics = Effect.gen(function* () {
        yield* ensureAuth(false);
        const response = yield* withRetry(
          withRateLimit(
            Effect.tryPromise<AppBskyUnspeccedGetTrendingTopics.Response>(() =>
              agent.app.bsky.unspecced.getTrendingTopics({
                limit: 25,
                ...(agent.did ? { viewer: agent.did } : {})
              })
            )
          )
        ).pipe(Effect.mapError(toBskyError("Failed to fetch trending topics", "getTrendingTopics")));

        const topics = [
          ...response.data.topics,
          ...response.data.suggested
        ]
          .map((topic) => topic.topic.trim().toLowerCase().replace(/^#/, ""))
          .filter((topic) => topic.length > 0);

        return Array.from(new Set(topics));
      });

      return BskyClient.of({
        getTimeline,
        getNotifications,
        getFeed,
        getListFeed,
        getAuthorFeed,
        getPost,
        getPostThread,
        getFollowers,
        getFollows,
        getKnownFollowers,
        getRelationships,
        getList,
        getLists,
        getBlocks,
        getMutes,
        getFeedGenerator,
        getFeedGenerators,
        getActorFeeds,
        getLikes,
        getRepostedBy,
        getQuotes,
        resolveHandle,
        resolveIdentity,
        getProfiles,
        searchActors,
        searchFeedGenerators,
        searchPosts,
        getTrendingTopics: () => getTrendingTopics
      });
    })
  );
}

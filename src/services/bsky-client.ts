import { AtpAgent } from "@atproto/api";
import { messageFromCause } from "./shared.js";
import type {
  AppBskyActorGetProfiles,
  AppBskyFeedDefs,
  AppBskyFeedGetFeed,
  AppBskyFeedGetPosts,
  AppBskyFeedGetTimeline,
  AppBskyFeedPost,
  AppBskyNotificationListNotifications,
  AppBskyUnspeccedGetTrendingTopics
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
  FeedContext,
  FeedPostBlocked,
  FeedPostNotFound,
  FeedPostUnknown,
  FeedPostViewRef,
  FeedReasonPin,
  FeedReasonRepost,
  FeedReasonUnknown,
  FeedReplyRef,
  Label,
  PostEmbed,
  PostMetrics,
  PostViewerState,
  ProfileBasic
} from "../domain/bsky.js";
import { PostCid, PostUri, Timestamp } from "../domain/primitives.js";

export interface TimelineOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface FeedOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface NotificationsOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

type FeedViewPost = AppBskyFeedDefs.FeedViewPost;
type PostView = AppBskyFeedDefs.PostView;


const toBskyError = (message: string) => (cause: unknown) =>
  BskyError.make({ message: messageFromCause(message, cause), cause });

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
          (mediaCandidate._tag === "Images" ||
            mediaCandidate._tag === "External" ||
            mediaCandidate._tag === "Video")
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
  Effect.forEach(feed, (item) =>
    Effect.gen(function* () {
      const context = yield* mapFeedContext(item);
      return yield* toRawPost(item.post, context);
    })
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

export class BskyClient extends Context.Tag("@skygent/BskyClient")<
  BskyClient,
  {
    readonly getTimeline: (opts?: TimelineOptions) => Stream.Stream<RawPost, BskyError>;
    readonly getNotifications: (
      opts?: NotificationsOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getFeed: (
      uri: string,
      opts?: FeedOptions
    ) => Stream.Stream<RawPost, BskyError>;
    readonly getPost: (uri: string) => Effect.Effect<RawPost, BskyError>;
    readonly getProfiles: (
      actors: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<ProfileBasic>, BskyError>;
    readonly getTrendingTopics: () => Effect.Effect<ReadonlyArray<string>, BskyError>;
  }
>() {
  static readonly layer = Layer.effect(
    BskyClient,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const credentials = yield* CredentialStore;
      const agent = new AtpAgent({ service: config.service });

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
            .pipe(Effect.mapError(toBskyError("Failed to load credentials")));
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
          ).pipe(Effect.mapError(toBskyError("Bluesky login failed")));
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
            ).pipe(Effect.mapError(toBskyError("Failed to fetch timeline")));
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
            ).pipe(Effect.mapError(toBskyError("Failed to fetch feed")));
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
          ).pipe(Effect.mapError(toBskyError("Failed to fetch post")));
          const postView = response.data.posts[0];
          if (!postView) {
            return yield* BskyError.make({
              message: "Post not found",
              cause: uri
            });
          }
          return yield* toRawPost(postView);
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
                Effect.mapError(toBskyError("Failed to fetch profiles")),
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
            ).pipe(Effect.mapError(toBskyError("Failed to fetch notifications")));

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
        ).pipe(Effect.mapError(toBskyError("Failed to fetch trending topics")));

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
        getPost,
        getProfiles,
        getTrendingTopics: () => getTrendingTopics
      });
    })
  );
}

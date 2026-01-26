import { AtpAgent, AppBskyFeedDefs, AppBskyFeedPost } from "@atproto/api";
import { Chunk, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { AppConfigService } from "./app-config.js";
import { BskyError } from "../domain/errors.js";
import { RawPost, RawPostRecord } from "../domain/raw.js";
import {
  EmbedAspectRatio,
  EmbedExternal,
  EmbedImage,
  EmbedImages,
  EmbedRecord,
  EmbedRecordWithMedia,
  EmbedUnknown,
  EmbedVideo,
  Label,
  PostEmbed,
  PostMetrics
} from "../domain/bsky.js";

export interface TimelineOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

type FeedViewPost = AppBskyFeedDefs.FeedViewPost;
type PostView = AppBskyFeedDefs.PostView;

const messageFromCause = (fallback: string, cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
};

const toBskyError = (message: string) => (cause: unknown) =>
  BskyError.make({ message: messageFromCause(message, cause), cause });

const mapAspectRatio = (input: unknown) => {
  if (!input || typeof input !== "object") return undefined;
  const ratio = input as { width?: unknown; height?: unknown };
  if (typeof ratio.width !== "number" || typeof ratio.height !== "number") {
    return undefined;
  }
  return EmbedAspectRatio.make({ width: ratio.width, height: ratio.height });
};

const mapEmbedView = (embed: unknown): PostEmbed | undefined => {
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
      const record = (embed as { record?: any }).record;
      const recordType = record && typeof record === "object" ? record.$type : undefined;
      return EmbedRecord.make({
        recordType,
        record: record ?? embed
      });
    }
    case "app.bsky.embed.recordWithMedia#view": {
      const record = (embed as { record?: any }).record;
      const recordType = record && typeof record === "object" ? record.$type : undefined;
      const mediaCandidate = mapEmbedView((embed as { media?: unknown }).media);
      const media =
        mediaCandidate &&
        (mediaCandidate._tag === "Images" ||
          mediaCandidate._tag === "External" ||
          mediaCandidate._tag === "Video")
          ? mediaCandidate
          : (embed as { media?: unknown }).media;
      return EmbedRecordWithMedia.make({
        recordType,
        record: record ?? embed,
        media
      });
    }
    default:
      if (typed.$type) {
        return EmbedUnknown.make({ rawType: typed.$type, data: embed });
      }
      return undefined;
  }
};

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

const withCursor = <T extends Record<string, unknown>>(
  params: T,
  cursor: string | undefined
): T & { cursor?: string } =>
  typeof cursor === "string" ? { ...params, cursor } : params;

const decodeRecord = (record: unknown) =>
  Schema.decodeUnknown(RawPostRecord)(record).pipe(
    Effect.mapError(toBskyError("Invalid post record"))
  );

const decodeLabels = (labels: unknown) =>
  Schema.decodeUnknown(Schema.Array(Label))(labels).pipe(
    Effect.mapError(toBskyError("Invalid moderation labels"))
  );

const toRawPost = (post: PostView) =>
  Effect.gen(function* () {
    const record = yield* decodeRecord(post.record);
    const labels =
      post.labels && post.labels.length > 0
        ? yield* decodeLabels(post.labels)
        : undefined;

    const raw = {
      uri: post.uri,
      cid: post.cid,
      author: post.author.handle,
      authorDid: post.author.did,
      record,
      indexedAt: post.indexedAt,
      labels,
      metrics: metricsFromPostView(post),
      embed: mapEmbedView(post.embed)
    };

    return yield* Schema.decodeUnknown(RawPost)(raw).pipe(
      Effect.mapError(toBskyError("Invalid post payload"))
    );
  });

const toRawPostsFromFeed = (feed: ReadonlyArray<FeedViewPost>) =>
  Effect.forEach(feed, (item) => toRawPost(item.post));

const isPostRecord = (record: unknown): record is AppBskyFeedPost.Record =>
  typeof record === "object" &&
  record !== null &&
  (record as { $type?: unknown }).$type === "app.bsky.feed.post";

export class BskyClient extends Context.Tag("@skygent/BskyClient")<
  BskyClient,
  {
    readonly getTimeline: (opts?: TimelineOptions) => Stream.Stream<RawPost, BskyError>;
    readonly getNotifications: () => Stream.Stream<RawPost, BskyError>;
    readonly getFeed: (uri: string) => Stream.Stream<RawPost, BskyError>;
  }
>() {
  static readonly layer = Layer.effect(
    BskyClient,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const agent = new AtpAgent({ service: config.service });

      const ensureAuth = (required: boolean) =>
        Effect.gen(function* () {
          if (agent.hasSession) {
            return;
          }
          if (!config.identifier || !config.password) {
            if (required) {
              return yield* BskyError.make({
                message:
                  "Missing Bluesky credentials. Provide identifier and password."
              });
            }
            return;
          }
          yield* Effect.tryPromise(() =>
            agent.login({
              identifier: config.identifier ?? "",
              password: config.password ?? ""
            })
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
            const response = yield* Effect.tryPromise(() =>
              agent.app.bsky.feed.getTimeline(params)
            ).pipe(Effect.mapError(toBskyError("Failed to fetch timeline")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const hasNext =
              posts.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(posts),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getFeed = (uri: string) =>
        paginate(undefined, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(false);
            const params = withCursor(
              { feed: uri, limit: 50 },
              cursor
            );
            const response = yield* Effect.tryPromise(() =>
              agent.app.bsky.feed.getFeed(params)
            ).pipe(Effect.mapError(toBskyError("Failed to fetch feed")));
            const posts = yield* toRawPostsFromFeed(response.data.feed);
            const nextCursor = response.data.cursor;
            const hasNext =
              posts.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(posts),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      const getNotifications = () =>
        paginate(undefined, (cursor) =>
          Effect.gen(function* () {
            yield* ensureAuth(true);
            const params = withCursor({ limit: 50 }, cursor);
            const response = yield* Effect.tryPromise(() =>
              agent.app.bsky.notification.listNotifications(params)
            ).pipe(Effect.mapError(toBskyError("Failed to fetch notifications")));

              const posts = yield* Effect.forEach(
                response.data.notifications,
                (notification) =>
                  Effect.gen(function* () {
                    if (!isPostRecord(notification.record)) {
                      return Option.none<RawPost>();
                    }
                    const record = yield* decodeRecord(notification.record);
                    const labels =
                      notification.labels && notification.labels.length > 0
                        ? yield* decodeLabels(notification.labels)
                        : undefined;
                    const raw = {
                      uri: notification.uri,
                      cid: notification.cid,
                      author: notification.author.handle,
                      authorDid: notification.author.did,
                      record,
                      indexedAt: notification.indexedAt,
                      labels
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
            const hasNext =
              filtered.length > 0 &&
              typeof nextCursor === "string" &&
              nextCursor !== cursor;
            return [
              Chunk.fromIterable(filtered),
              hasNext ? Option.some(nextCursor) : Option.none()
            ] as const;
          })
        );

      return BskyClient.of({
        getTimeline,
        getNotifications,
        getFeed
      });
    })
  );
}

import { Effect, Schema } from "effect";
import type * as SqlClient from "@effect/sql/SqlClient";
import { StoreIndexError } from "../domain/errors.js";
import { extractImageRefs } from "../domain/embeds.js";
import { Post } from "../domain/post.js";
import type { PostUri } from "../domain/primitives.js";

const toStoreIndexError = (message: string) => (cause: unknown) =>
  StoreIndexError.make({ message, cause });

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const encodePostJson = (post: Post) =>
  Schema.encode(Schema.parseJson(Post))(post).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.post encode failed"))
  );

const embedTag = (embed: Post["embed"]): string | undefined => {
  if (!embed || typeof embed !== "object" || !("_tag" in embed)) {
    return undefined;
  }
  const tag = (embed as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const embedMediaTag = (embed: Post["embed"]): string | undefined => {
  if (!embed || typeof embed !== "object" || !("_tag" in embed)) {
    return undefined;
  }
  const tag = (embed as { readonly _tag?: unknown })._tag;
  if (tag !== "RecordWithMedia") {
    return undefined;
  }
  const media = (embed as { readonly media?: unknown }).media;
  if (!media || typeof media !== "object" || !("_tag" in media)) {
    return undefined;
  }
  const mediaTag = (media as { readonly _tag?: unknown })._tag;
  return typeof mediaTag === "string" ? mediaTag : undefined;
};

const hasExternalLink = (post: Post) => {
  if (post.links.length > 0) {
    return true;
  }
  const tag = embedTag(post.embed);
  if (tag === "External") {
    return true;
  }
  return embedMediaTag(post.embed) === "External";
};

const hasVideo = (post: Post) => {
  const tag = embedTag(post.embed);
  if (tag === "Video") {
    return true;
  }
  return embedMediaTag(post.embed) === "Video";
};

const hasEmbed = (post: Post) =>
  post.embed != null || post.recordEmbed != null;

const normalizeLangs = (langs: ReadonlyArray<string> | undefined) =>
  Array.from(
    new Set(
      (langs ?? [])
        .map((lang) => lang.trim().toLowerCase())
        .filter((lang) => lang.length > 0)
    )
  );

const isRepost = (post: Post) => {
  const reason = post.feed?.reason;
  if (!reason || typeof reason !== "object") {
    return false;
  }
  const tag = (reason as { readonly _tag?: unknown })._tag;
  return tag === "ReasonRepost";
};

const isQuote = (post: Post) => {
  const tag = embedTag(post.embed);
  return tag === "Record" || tag === "RecordWithMedia";
};

const toFlag = (value: boolean) => (value ? 1 : 0);

export const upsertPost = (
  sql: SqlClient.SqlClient,
  post: Post
) =>
  Effect.gen(function* () {
    const createdAt = toIso(post.createdAt);
    const createdDate = createdAt.slice(0, 10);
    const postJson = yield* encodePostJson(post);
    const normalizedLangs = normalizeLangs(post.langs);
    const lang = normalizedLangs[0];
    const isReply = Boolean(post.reply);
    const quote = isQuote(post);
    const repost = isRepost(post);
    const original = !isReply && !quote && !repost;
    const links = hasExternalLink(post);
    const imageRefs = extractImageRefs(post.embed);
    const imageCount = imageRefs.length;
    const images = imageCount > 0;
    const altTexts = imageRefs.flatMap((image) => image.alt ? [image.alt] : []);
    const altText = altTexts.join("\n");
    const hasAltText = imageCount > 0 && altTexts.length === imageCount;
    const video = hasVideo(post);
    const media = images || video || links;
    const embed = hasEmbed(post);
    const metrics = post.metrics;
    const likeCount = metrics?.likeCount ?? 0;
    const repostCount = metrics?.repostCount ?? 0;
    const replyCount = metrics?.replyCount ?? 0;

    yield* sql`INSERT INTO posts (
        uri,
        created_at,
        created_date,
        author,
        text,
        lang,
        is_reply,
        is_quote,
        is_repost,
        is_original,
        has_links,
        has_media,
        has_embed,
        has_images,
        image_count,
        alt_text,
        has_alt_text,
        has_video,
        like_count,
        repost_count,
        reply_count,
        post_json
      )
      VALUES (
        ${post.uri},
        ${createdAt},
        ${createdDate},
        ${post.author},
        ${post.text},
        ${lang},
        ${toFlag(isReply)},
        ${toFlag(quote)},
        ${toFlag(repost)},
        ${toFlag(original)},
        ${toFlag(links)},
        ${toFlag(media)},
        ${toFlag(embed)},
        ${toFlag(images)},
        ${imageCount},
        ${altText},
        ${toFlag(hasAltText)},
        ${toFlag(video)},
        ${likeCount},
        ${repostCount},
        ${replyCount},
        ${postJson}
      )
      ON CONFLICT(uri) DO UPDATE SET
        created_at = excluded.created_at,
        created_date = excluded.created_date,
        author = excluded.author,
        text = excluded.text,
        lang = excluded.lang,
        is_reply = excluded.is_reply,
        is_quote = excluded.is_quote,
        is_repost = excluded.is_repost,
        is_original = excluded.is_original,
        has_links = excluded.has_links,
        has_media = excluded.has_media,
        has_embed = excluded.has_embed,
        has_images = excluded.has_images,
        image_count = excluded.image_count,
        alt_text = excluded.alt_text,
        has_alt_text = excluded.has_alt_text,
        has_video = excluded.has_video,
        like_count = excluded.like_count,
        repost_count = excluded.repost_count,
        reply_count = excluded.reply_count,
        post_json = excluded.post_json`;

    yield* sql`DELETE FROM post_hashtag WHERE uri = ${post.uri}`;

    const tags = Array.from(new Set(post.hashtags));
    if (tags.length > 0) {
      const rows = tags.map((tag) => ({ uri: post.uri, tag }));
      yield* sql`INSERT INTO post_hashtag ${sql.insert(rows)}`;
    }

    yield* sql`DELETE FROM post_lang WHERE uri = ${post.uri}`;
    if (normalizedLangs.length > 0) {
      const rows = normalizedLangs.map((lang) => ({ uri: post.uri, lang }));
      yield* sql`INSERT INTO post_lang ${sql.insert(rows)}`;
    }
  });

export const insertPostIfMissing = (
  sql: SqlClient.SqlClient,
  post: Post
) =>
  Effect.gen(function* () {
    const createdAt = toIso(post.createdAt);
    const createdDate = createdAt.slice(0, 10);
    const postJson = yield* encodePostJson(post);
    const normalizedLangs = normalizeLangs(post.langs);
    const lang = normalizedLangs[0];
    const isReply = Boolean(post.reply);
    const quote = isQuote(post);
    const repost = isRepost(post);
    const original = !isReply && !quote && !repost;
    const links = hasExternalLink(post);
    const imageRefs = extractImageRefs(post.embed);
    const imageCount = imageRefs.length;
    const images = imageCount > 0;
    const altTexts = imageRefs.flatMap((image) => image.alt ? [image.alt] : []);
    const altText = altTexts.join("\n");
    const hasAltText = imageCount > 0 && altTexts.length === imageCount;
    const video = hasVideo(post);
    const media = images || video || links;
    const embed = hasEmbed(post);
    const metrics = post.metrics;
    const likeCount = metrics?.likeCount ?? 0;
    const repostCount = metrics?.repostCount ?? 0;
    const replyCount = metrics?.replyCount ?? 0;

    const rows = yield* sql`INSERT INTO posts (
        uri,
        created_at,
        created_date,
        author,
        text,
        lang,
        is_reply,
        is_quote,
        is_repost,
        is_original,
        has_links,
        has_media,
        has_embed,
        has_images,
        image_count,
        alt_text,
        has_alt_text,
        has_video,
        like_count,
        repost_count,
        reply_count,
        post_json
      )
      VALUES (
        ${post.uri},
        ${createdAt},
        ${createdDate},
        ${post.author},
        ${post.text},
        ${lang},
        ${toFlag(isReply)},
        ${toFlag(quote)},
        ${toFlag(repost)},
        ${toFlag(original)},
        ${toFlag(links)},
        ${toFlag(media)},
        ${toFlag(embed)},
        ${toFlag(images)},
        ${imageCount},
        ${altText},
        ${toFlag(hasAltText)},
        ${toFlag(video)},
        ${likeCount},
        ${repostCount},
        ${replyCount},
        ${postJson}
      )
      ON CONFLICT(uri) DO NOTHING
      RETURNING uri`;

    if (rows.length === 0) {
      return false;
    }

    const tags = Array.from(new Set(post.hashtags));
    if (tags.length > 0) {
      const tagRows = tags.map((tag) => ({ uri: post.uri, tag }));
      yield* sql`INSERT INTO post_hashtag ${sql.insert(tagRows)}`;
    }

    if (normalizedLangs.length > 0) {
      const langRows = normalizedLangs.map((lang) => ({ uri: post.uri, lang }));
      yield* sql`INSERT INTO post_lang ${sql.insert(langRows)}`;
    }

    return true;
  });

export const deletePost = (sql: SqlClient.SqlClient, uri: PostUri) =>
  sql`DELETE FROM posts WHERE uri = ${uri}`.pipe(Effect.asVoid);

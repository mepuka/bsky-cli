import { Args, Command, Options } from "@effect/cli";
import { Duration, Effect, Option, Stream } from "effect";
import { AppConfigService } from "../services/app-config.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreQuery } from "../domain/events.js";
import { StoreName } from "../domain/primitives.js";
import type { Post } from "../domain/post.js";
import type { PostMetrics } from "../domain/bsky.js";
import { truncate, collapseWhitespace } from "../domain/format.js";
import { writeJson, writeText } from "./output.js";
import { emitWithFormat } from "./output-render.js";
import { parseRangeOptions } from "./range-options.js";
import { withExamples } from "./help.js";
import { storeOptions } from "./store.js";
import { renderTableLegacy } from "./doc/table.js";

const digestFormats = ["json", "markdown", "table"] as const;

const storeNameArg = Args.text({ name: "store" }).pipe(
  Args.withSchema(StoreName),
  Args.withDescription("Store name")
);

const rangeOption = Options.text("range").pipe(
  Options.withDescription("ISO range as <start>..<end>"),
  Options.optional
);

const sinceOption = Options.text("since").pipe(
  Options.withDescription("Start time (ISO) or duration (e.g. 24h)"),
  Options.optional
);

const untilOption = Options.text("until").pipe(
  Options.withDescription("End time (ISO) or duration (e.g. 30m)"),
  Options.optional
);

const formatOption = Options.choice("format", digestFormats).pipe(
  Options.withDescription("Output format (default: config output format)"),
  Options.optional
);

type DigestBucketUnit = "hour" | "day";

type DigestTopPost = {
  readonly uri: string;
  readonly author: string;
  readonly createdAt: string;
  readonly text: string;
  readonly score: number;
  readonly metrics: {
    readonly likes: number;
    readonly reposts: number;
    readonly replies: number;
    readonly quotes: number;
  };
};

type DigestHashtag = { readonly tag: string; readonly count: number };
type DigestAuthor = { readonly author: string; readonly posts: number; readonly firstSeen: string };
type DigestVolume = { readonly bucket: string; readonly count: number };

type DigestOutput = {
  readonly store: string;
  readonly range: { readonly start: string; readonly end: string };
  readonly posts: { readonly total: number };
  readonly authors: { readonly total: number; readonly newAuthors: ReadonlyArray<DigestAuthor> };
  readonly hashtags: ReadonlyArray<DigestHashtag>;
  readonly topPosts: ReadonlyArray<DigestTopPost>;
  readonly volume: { readonly unit: DigestBucketUnit; readonly buckets: ReadonlyArray<DigestVolume> };
};

const metricsValue = (metrics: PostMetrics | undefined, key: keyof PostMetrics) =>
  typeof metrics?.[key] === "number" ? metrics[key]! : 0;

const engagementScore = (metrics: PostMetrics | undefined) =>
  metricsValue(metrics, "likeCount") +
  2 * metricsValue(metrics, "repostCount") +
  3 * metricsValue(metrics, "replyCount") +
  2 * metricsValue(metrics, "quoteCount");

const bucketUnitForRange = (start: Date, end: Date): DigestBucketUnit => {
  const rangeMs = Math.max(0, end.getTime() - start.getTime());
  return rangeMs <= Duration.toMillis(Duration.hours(48)) ? "hour" : "day";
};

const bucketStart = (date: Date, unit: DigestBucketUnit): Date => {
  if (unit === "hour") {
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours()
    ));
  }
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
};

const updateCount = (map: Map<string, number>, key: string) => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const updateTopPosts = (
  posts: Array<DigestTopPost>,
  candidate: DigestTopPost,
  limit: number
) => {
  const shouldAdd =
    posts.length < limit ||
    candidate.score > (posts[posts.length - 1]?.score ?? -1);
  if (!shouldAdd) {
    return;
  }
  posts.push(candidate);
  posts.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return b.createdAt.localeCompare(a.createdAt);
  });
  if (posts.length > limit) {
    posts.length = limit;
  }
};

const sortCounts = (entries: Iterable<[string, number]>) =>
  [...entries].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

const renderMarkdownTable = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
) => {
  const header = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map((label) => "-".repeat(Math.max(label.length, 3))).join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
};

const renderDigestTable = (digest: DigestOutput) => {
  const summary = [
    `Store: ${digest.store}`,
    `Range: ${digest.range.start}..${digest.range.end}`,
    `Posts: ${digest.posts.total}`,
    `Authors: ${digest.authors.total}`
  ].join("\n");

  const topPostsRows = digest.topPosts.map((post) => [
    post.score.toString(),
    post.metrics.likes.toString(),
    post.metrics.reposts.toString(),
    post.metrics.replies.toString(),
    post.metrics.quotes.toString(),
    post.author,
    post.createdAt,
    post.text
  ]);
  const topPostsTable = topPostsRows.length > 0
    ? renderTableLegacy(
        ["SCORE", "LIKES", "REPOSTS", "REPLIES", "QUOTES", "AUTHOR", "CREATED", "TEXT"],
        topPostsRows
      )
    : "No posts found.";

  const hashtagRows = digest.hashtags.map((tag) => [tag.tag, tag.count.toString()]);
  const hashtagTable = hashtagRows.length > 0
    ? renderTableLegacy(["HASHTAG", "COUNT"], hashtagRows)
    : "No hashtags found.";

  const authorRows = digest.authors.newAuthors.map((author) => [
    author.author,
    author.posts.toString(),
    author.firstSeen
  ]);
  const authorTable = authorRows.length > 0
    ? renderTableLegacy(["AUTHOR", "POSTS", "FIRST SEEN"], authorRows)
    : "No authors found.";

  const volumeRows = digest.volume.buckets.map((bucket) => [
    bucket.bucket,
    bucket.count.toString()
  ]);
  const volumeTable = volumeRows.length > 0
    ? renderTableLegacy(["BUCKET", "POSTS"], volumeRows)
    : "No posts found.";

  return [
    summary,
    "",
    "Top Posts",
    topPostsTable,
    "",
    "Top Hashtags",
    hashtagTable,
    "",
    "New Authors",
    authorTable,
    "",
    `Volume (${digest.volume.unit})`,
    volumeTable
  ].join("\n");
};

const renderDigestMarkdown = (digest: DigestOutput) => {
  const summary = [
    `# Digest: ${digest.store}`,
    "",
    `- Range: ${digest.range.start}..${digest.range.end}`,
    `- Posts: ${digest.posts.total}`,
    `- Authors: ${digest.authors.total}`
  ].join("\n");

  const topPostsRows = digest.topPosts.map((post) => [
    post.score.toString(),
    post.metrics.likes.toString(),
    post.metrics.reposts.toString(),
    post.metrics.replies.toString(),
    post.metrics.quotes.toString(),
    post.author,
    post.createdAt,
    post.text
  ]);
  const topPostsTable = topPostsRows.length > 0
    ? renderMarkdownTable(
        ["Score", "Likes", "Reposts", "Replies", "Quotes", "Author", "Created", "Text"],
        topPostsRows
      )
    : "_No posts found._";

  const hashtagRows = digest.hashtags.map((tag) => [tag.tag, tag.count.toString()]);
  const hashtagTable = hashtagRows.length > 0
    ? renderMarkdownTable(["Hashtag", "Count"], hashtagRows)
    : "_No hashtags found._";

  const authorRows = digest.authors.newAuthors.map((author) => [
    author.author,
    author.posts.toString(),
    author.firstSeen
  ]);
  const authorTable = authorRows.length > 0
    ? renderMarkdownTable(["Author", "Posts", "First Seen"], authorRows)
    : "_No authors found._";

  const volumeRows = digest.volume.buckets.map((bucket) => [
    bucket.bucket,
    bucket.count.toString()
  ]);
  const volumeTable = volumeRows.length > 0
    ? renderMarkdownTable(["Bucket", "Posts"], volumeRows)
    : "_No posts found._";

  return [
    summary,
    "",
    "## Top Posts",
    topPostsTable,
    "",
    "## Top Hashtags",
    hashtagTable,
    "",
    "## New Authors",
    authorTable,
    "",
    `## Volume (${digest.volume.unit})`,
    volumeTable
  ].join("\n");
};

export const digestCommand = Command.make(
  "digest",
  { store: storeNameArg, range: rangeOption, since: sinceOption, until: untilOption, format: formatOption },
  ({ store, range, since, until, format }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const index = yield* StoreIndex;
      const storeRef = yield* storeOptions.loadStoreRef(store);

      const parsedRange = yield* parseRangeOptions(range, since, until, {
        since: "24h",
        until: "now"
      });

      if (Option.isNone(parsedRange)) {
        return yield* writeJson({
          store: storeRef.name,
          range: null,
          posts: { total: 0 },
          authors: { total: 0, newAuthors: [] },
          hashtags: [],
          topPosts: [],
          volume: { unit: "hour", buckets: [] }
        });
      }

      const { start, end } = parsedRange.value;
      const rangeValue = { start, end };
      const unit = bucketUnitForRange(start, end);
      const topLimit = 5;
      const tagLimit = 10;
      const authorLimit = 10;

      const query = StoreQuery.make({
        range: rangeValue,
        order: "desc"
      });

      type AuthorStats = { count: number; firstSeen: Date };
      type DigestState = {
        totalPosts: number;
        hashtags: Map<string, number>;
        authors: Map<string, AuthorStats>;
        topPosts: Array<DigestTopPost>;
        buckets: Map<string, number>;
      };

      const initialState: DigestState = {
        totalPosts: 0,
        hashtags: new Map(),
        authors: new Map(),
        topPosts: [],
        buckets: new Map()
      };

      const normalizeText = (text: string) => truncate(collapseWhitespace(text), 120);

      const digestState = yield* index
        .query(storeRef, query)
        .pipe(
          Stream.runFold(initialState, (state, post: Post) => {
            state.totalPosts += 1;

            for (const tag of post.hashtags) {
              updateCount(state.hashtags, tag);
            }

            const authorStats = state.authors.get(post.author);
            if (authorStats) {
              authorStats.count += 1;
              if (post.createdAt.getTime() < authorStats.firstSeen.getTime()) {
                authorStats.firstSeen = post.createdAt;
              }
            } else {
              state.authors.set(post.author, {
                count: 1,
                firstSeen: post.createdAt
              });
            }

            const score = engagementScore(post.metrics);
            const metrics = {
              likes: metricsValue(post.metrics, "likeCount"),
              reposts: metricsValue(post.metrics, "repostCount"),
              replies: metricsValue(post.metrics, "replyCount"),
              quotes: metricsValue(post.metrics, "quoteCount")
            };
            const candidate: DigestTopPost = {
              uri: post.uri,
              author: post.author,
              createdAt: post.createdAt.toISOString(),
              text: normalizeText(post.text),
              score,
              metrics
            };
            updateTopPosts(state.topPosts, candidate, topLimit);

            const bucket = bucketStart(post.createdAt, unit).toISOString();
            updateCount(state.buckets, bucket);

            return state;
          })
        );

      const hashtags = sortCounts(digestState.hashtags.entries())
        .slice(0, tagLimit)
        .map(([tag, count]) => ({ tag, count }));

      const authors = [...digestState.authors.entries()]
        .map(([author, stats]) => ({
          author,
          posts: stats.count,
          firstSeen: stats.firstSeen.toISOString()
        }))
        .sort((a, b) => {
          if (a.posts !== b.posts) return b.posts - a.posts;
          return a.firstSeen.localeCompare(b.firstSeen);
        })
        .slice(0, authorLimit);

      const volume = sortCounts(digestState.buckets.entries()).map(
        ([bucket, count]) => ({ bucket, count })
      );

      const digest: DigestOutput = {
        store: storeRef.name,
        range: { start: start.toISOString(), end: end.toISOString() },
        posts: { total: digestState.totalPosts },
        authors: { total: digestState.authors.size, newAuthors: authors },
        hashtags,
        topPosts: digestState.topPosts,
        volume: { unit, buckets: volume }
      };

      return yield* emitWithFormat(
        format,
        appConfig.outputFormat,
        digestFormats,
        "json",
        {
          json: writeJson(digest),
          markdown: writeText(renderDigestMarkdown(digest)),
          table: writeText(renderDigestTable(digest))
        }
      );
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Summarize a store for a time window",
      [
        "skygent digest my-store --since 24h",
        "skygent digest my-store --range 2026-01-01T00:00:00Z..2026-01-02T00:00:00Z --format markdown"
      ]
    )
  )
);

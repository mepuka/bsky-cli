import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Schema, Stream } from "effect";
import * as fc from "effect/FastCheck";
import * as Arbitrary from "effect/Arbitrary";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { EventMeta, PostDelete, PostEventRecord, PostUpsert, StoreQuery } from "../../src/domain/events.js";
import { EventId, Handle, Hashtag, PostUri } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

const postUriArb = Arbitrary.make(PostUri);
const handleArb = Arbitrary.make(Handle);
const hashtagArb = Arbitrary.make(Hashtag);
const minDate = new Date("2026-01-01T00:00:00.000Z");
const maxDate = new Date("2026-01-31T23:59:59.000Z");
const createdAtArb = fc.date({ min: minDate, max: maxDate });
const postArb = fc
  .record({
    uri: postUriArb,
    author: handleArb,
    text: fc.string({ minLength: 1, maxLength: 120 }),
    createdAt: createdAtArb,
    hashtags: fc.array(hashtagArb, { maxLength: 3 }),
    mentions: fc.array(handleArb, { maxLength: 2 }),
    links: fc.array(fc.webUrl().map((value) => new URL(value)), { maxLength: 2 })
  })
  .map((data) =>
    Post.make({
      uri: data.uri,
      author: data.author,
      text: data.text,
      createdAt: data.createdAt,
      hashtags: data.hashtags,
      mentions: data.mentions,
      links: data.links
    })
  );

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "property-store",
  root: "/tmp/property-store"
});

const eventId = Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FAV");

const makeMeta = (createdAt: Date) =>
  EventMeta.make({
    source: "timeline",
    command: "property",
    createdAt
  });

type EventInput =
  | { readonly _tag: "PostUpsert"; readonly post: Post }
  | { readonly _tag: "PostDelete"; readonly uri: PostUri };

const eventArb: fc.Arbitrary<EventInput> = fc.oneof(
  postArb.map((post) => ({ _tag: "PostUpsert", post } as const)),
  postArb.map((post) => ({ _tag: "PostDelete", uri: post.uri } as const))
);

const rangeArb = fc.option(
  fc
    .record({
      start: createdAtArb,
      days: fc.integer({ min: 0, max: 10 })
    })
    .map(({ start, days }) => {
      const end = new Date(start.getTime());
      end.setUTCDate(end.getUTCDate() + days);
      return { start, end };
    }),
  { nil: undefined }
);

const limitArb = fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined });

const toDate = (value: Date | string) =>
  typeof value === "string" ? new Date(value) : value;

const dateKeysInRange = (start: Date, end: Date): ReadonlyArray<string> => {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  if (Number.isNaN(startUtc) || Number.isNaN(endUtc) || startUtc > endUtc) {
    return [];
  }
  const dates: Array<string> = [];
  for (let ts = startUtc; ts <= endUtc; ts += 24 * 60 * 60 * 1000) {
    dates.push(new Date(ts).toISOString().slice(0, 10));
  }
  return dates;
};

type ModelEntry = { readonly createdDate: string; readonly hashtags: ReadonlyArray<string> };

type ModelState = {
  readonly posts: Map<PostUri, Post>;
  readonly entries: Map<PostUri, ModelEntry>;
  readonly uris: Array<PostUri>;
  readonly byDate: Map<string, Array<PostUri>>;
  readonly byTag: Map<string, Array<PostUri>>;
};

const createModel = (): ModelState => ({
  posts: new Map(),
  entries: new Map(),
  uris: [],
  byDate: new Map(),
  byTag: new Map()
});

const upsertList = (list: Array<PostUri>, uri: PostUri) => {
  if (!list.includes(uri)) {
    list.push(uri);
  }
};

const removeFromList = (list: Array<PostUri>, uri: PostUri) => {
  const next = list.filter((value) => value !== uri);
  list.length = 0;
  list.push(...next);
};

const applyUpsertModel = (model: ModelState, post: Post) => {
  const createdDate = toDate(post.createdAt).toISOString().slice(0, 10);
  const entry: ModelEntry = { createdDate, hashtags: post.hashtags };

  model.entries.set(post.uri, entry);
  model.posts.set(post.uri, post);

  upsertList(model.uris, post.uri);

  const dateList = model.byDate.get(createdDate) ?? [];
  upsertList(dateList, post.uri);
  model.byDate.set(createdDate, dateList);

  for (const tag of entry.hashtags) {
    const tagList = model.byTag.get(tag) ?? [];
    upsertList(tagList, post.uri);
    model.byTag.set(tag, tagList);
  }
};

const applyDeleteModel = (model: ModelState, uri: PostUri) => {
  const entry = model.entries.get(uri);
  if (!entry) {
    return;
  }

  const dateList = model.byDate.get(entry.createdDate);
  if (dateList) {
    removeFromList(dateList, uri);
    if (dateList.length === 0) {
      model.byDate.delete(entry.createdDate);
    }
  }

  for (const tag of entry.hashtags) {
    const tagList = model.byTag.get(tag);
    if (tagList) {
      removeFromList(tagList, uri);
      if (tagList.length === 0) {
        model.byTag.delete(tag);
      }
    }
  }

  removeFromList(model.uris, uri);
  model.entries.delete(uri);
  model.posts.delete(uri);
};

const queryModel = (
  model: ModelState,
  range: { start: Date; end: Date } | undefined,
  limit: number | undefined
) => {
  const collected: Array<Post> = [];
  const pushPost = (uri: PostUri) => {
    const post = model.posts.get(uri);
    if (post) {
      collected.push(post);
    }
  };

  if (range) {
    for (const date of dateKeysInRange(range.start, range.end)) {
      const list = model.byDate.get(date) ?? [];
      for (const uri of list) {
        pushPost(uri);
        if (limit !== undefined && collected.length >= limit) {
          return collected;
        }
      }
    }
  } else {
    for (const uri of model.uris) {
      pushPost(uri);
      if (limit !== undefined && collected.length >= limit) {
        return collected;
      }
    }
  }

  return collected;
};

const buildLayer = () =>
  Layer.mergeAll(StoreIndex.layer).pipe(
    Layer.provideMerge(StoreEventLog.layer),
    Layer.provideMerge(KeyValueStore.layerMemory)
  );

describe("StoreIndex property", () => {
  test("query matches naive model", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(eventArb, { minLength: 0, maxLength: 10 }),
        rangeArb,
        limitArb,
        async (events, rangeInput, limit) => {
          const range = rangeInput
            ? { start: toDate(rangeInput.start), end: toDate(rangeInput.end) }
            : undefined;

          const program = Effect.gen(function* () {
            const storeIndex = yield* StoreIndex;
            const model = createModel();

            for (const event of events) {
              if (event._tag === "PostUpsert") {
                const meta = makeMeta(toDate(event.post.createdAt));
                const upsert = PostUpsert.make({ post: event.post, meta });
                const record = PostEventRecord.make({
                  id: eventId,
                  version: 1,
                  event: upsert
                });
                yield* storeIndex.apply(sampleStore, record);
                applyUpsertModel(model, event.post);
              } else {
                const meta = makeMeta(new Date(0));
                const del = PostDelete.make({ uri: event.uri, meta });
                const record = PostEventRecord.make({
                  id: eventId,
                  version: 1,
                  event: del
                });
                yield* storeIndex.apply(sampleStore, record);
                applyDeleteModel(model, event.uri);
              }
            }

            const query = StoreQuery.make({
              range,
              limit
            });

            const collected = yield* storeIndex
              .query(sampleStore, query)
              .pipe(Stream.runCollect);

            const actual = Chunk.toReadonlyArray(collected);
            const expected = queryModel(model, range, limit);

            return { actual, expected };
          });

          const result = await Effect.runPromise(
            program.pipe(Effect.provide(buildLayer()))
          );

          expect(result.actual.map((post) => post.uri)).toEqual(
            result.expected.map((post) => post.uri)
          );
        }
      ),
      { numRuns: 10 }
    );
  });
});

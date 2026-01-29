import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService } from "../../src/services/app-config.js";
import { BskyClient } from "../../src/services/bsky-client.js";
import { CredentialStore } from "../../src/services/credential-store.js";
import { makeBskyMockLayer } from "../support/bsky-mock-server.js";

// Minimal valid profile
const mockProfile = {
  did: "did:plc:test",
  handle: "test.bsky.social",
  displayName: "Test User",
  description: "A test user",
  indexedAt: "2024-01-01T00:00:00Z",
  viewer: {
    muted: false,
    blockedBy: false
  },
  labels: []
};

const mockFollowers = {
  subject: mockProfile,
  followers: [mockProfile],
  cursor: "next-cursor"
};

const mockFollows = {
  subject: mockProfile,
  follows: [mockProfile],
  cursor: "next-cursor"
};

const mockKnownFollowers = {
  subject: mockProfile,
  followers: [mockProfile],
  cursor: "next-cursor"
};

const mockBlocks = {
  blocks: [mockProfile],
  cursor: "next-cursor"
};

const mockMutes = {
  mutes: [mockProfile],
  cursor: "next-cursor"
};

const mockRelationships = {
  actor: "did:plc:actor",
  relationships: [
    {
      $type: "app.bsky.graph.defs#relationship",
      did: "did:plc:target",
      following: "at://did:plc:actor/app.bsky.graph.follow/1",
      followedBy: "at://did:plc:target/app.bsky.graph.follow/2"
    }
  ]
};

// Valid CID from timeline.json
const validCid = "bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm";

const mockLists = {
  lists: [
    {
      uri: "at://did:plc:test/app.bsky.graph.list/1",
      cid: validCid,
      name: "Test List",
      purpose: "app.bsky.graph.defs#curatelist",
      creator: mockProfile,
      indexedAt: "2024-01-01T00:00:00Z",
      viewer: {
        muted: false
      }
    }
  ],
  cursor: "next-cursor"
};

const mockList = {
  list: mockLists.lists[0],
  items: [
    {
      uri: "at://did:plc:test/app.bsky.graph.listitem/1",
      subject: mockProfile
    }
  ],
  cursor: "next-cursor"
};

const mockPost = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  cid: validCid,
  author: mockProfile,
  record: {
    $type: "app.bsky.feed.post",
    text: "Hello world",
    createdAt: "2024-01-01T00:00:00Z"
  },
  indexedAt: "2024-01-01T00:00:00Z",
  likeCount: 10,
  replyCount: 0,
  repostCount: 0,
  quoteCount: 0,
  labels: [],
  viewer: {}
};

const mockSearchPosts = {
  posts: [mockPost],
  cursor: "next-cursor",
  hitsTotal: 100
};

const mockResolveHandle = {
  did: "did:plc:resolved"
};

const mockLikes = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  cid: validCid,
  likes: [
    {
      actor: mockProfile,
      createdAt: "2024-01-01T00:00:00Z",
      indexedAt: "2024-01-01T00:00:00Z"
    }
  ],
  cursor: "next-cursor"
};

const mockRepostedBy = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  cid: validCid,
  repostedBy: [mockProfile],
  cursor: "next-cursor"
};

const mockQuotes = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  cid: validCid,
  posts: [mockPost],
  cursor: "next-cursor"
};

const mockFeedGenerator = {
  view: {
    uri: "at://did:plc:test/app.bsky.feed.generator/1",
    cid: validCid,
    did: "did:web:feed.example.com",
    creator: mockProfile,
    displayName: "Test Feed",
    description: "A test feed",
    indexedAt: "2024-01-01T00:00:00Z",
    likeCount: 100
  },
  isOnline: true,
  isValid: true
};

describe("BskyClient Graph & Search", () => {
  const makeLayer = (fixtures: any) => {
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer(fixtures)
    );
    const appConfigLayer = AppConfigService.layer.pipe(
      Layer.provideMerge(baseLayer)
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(baseLayer)
    );
    return BskyClient.layer.pipe(
      Layer.provideMerge(appConfigLayer),
      Layer.provideMerge(credentialLayer)
    );
  };

  test("getFollowers returns followers", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getFollowers("did:plc:test");
      }).pipe(Effect.provide(makeLayer({ followers: mockFollowers })))
    );

    const result = await Effect.runPromise(program);
    expect(result.followers.length).toBe(1);
    expect(result.followers[0].did).toBe(mockProfile.did);
    expect(result.cursor).toBe("next-cursor");
  });

  test("getFollows returns follows", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getFollows("did:plc:test");
      }).pipe(Effect.provide(makeLayer({ follows: mockFollows })))
    );

    const result = await Effect.runPromise(program);
    expect(result.follows.length).toBe(1);
    expect(result.follows[0].did).toBe(mockProfile.did);
  });

  test("getKnownFollowers returns followers", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getKnownFollowers("did:plc:test");
      }).pipe(Effect.provide(makeLayer({ knownFollowers: mockKnownFollowers })))
    );

    const result = await Effect.runPromise(program);
    expect(result.followers.length).toBe(1);
  });

  test("getRelationships returns relationships", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getRelationships("did:plc:actor", ["did:plc:target"]);
      }).pipe(Effect.provide(makeLayer({ relationships: mockRelationships })))
    );

    const result = await Effect.runPromise(program);
    expect(result.relationships.length).toBe(1);
    const rel = result.relationships[0] as any;
    expect(rel.did).toBe("did:plc:target");
    expect(rel.following).toBe("at://did:plc:actor/app.bsky.graph.follow/1");
  });

  test("getLists returns lists", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getLists("did:plc:test");
      }).pipe(Effect.provide(makeLayer({ lists: mockLists })))
    );

    const result = await Effect.runPromise(program);
    expect(result.lists.length).toBe(1);
    expect(result.lists[0].name).toBe("Test List");
  });

  test("getList returns list and items", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getList("at://did:plc:test/app.bsky.graph.list/1");
      }).pipe(Effect.provide(makeLayer({ list: mockList })))
    );

    const result = await Effect.runPromise(program);
    expect(result.list.name).toBe("Test List");
    expect(result.items.length).toBe(1);
    expect(result.items[0].subject.did).toBe(mockProfile.did);
  });

  test("getBlocks returns blocks", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getBlocks();
      }).pipe(Effect.provide(makeLayer({ blocks: mockBlocks })))
    );

    const result = await Effect.runPromise(program);
    expect(result.blocks.length).toBe(1);
  });

  test("getMutes returns mutes", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getMutes();
      }).pipe(Effect.provide(makeLayer({ mutes: mockMutes })))
    );

    const result = await Effect.runPromise(program);
    expect(result.mutes.length).toBe(1);
  });

  test("searchPosts returns posts", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.searchPosts("query");
      }).pipe(Effect.provide(makeLayer({ searchPosts: mockSearchPosts })))
    );

    const result = await Effect.runPromise(program);
    expect(result.posts.length).toBe(1);
    expect(result.hitsTotal).toBe(100);
    expect(result.posts[0].author).toBe("test.bsky.social");
  });

  test("resolveHandle returns DID", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.resolveHandle("test.bsky.social");
      }).pipe(Effect.provide(makeLayer({ resolveHandle: mockResolveHandle })))
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("did:plc:resolved");
  });

  test("getLikes returns likes", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getLikes("at://post");
      }).pipe(Effect.provide(makeLayer({ likes: mockLikes })))
    );

    const result = await Effect.runPromise(program);
    expect(result.likes.length).toBe(1);
    expect(result.likes[0].actor.handle).toBe("test.bsky.social");
  });

  test("getRepostedBy returns profiles", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getRepostedBy("at://post");
      }).pipe(Effect.provide(makeLayer({ repostedBy: mockRepostedBy })))
    );

    const result = await Effect.runPromise(program);
    expect(result.repostedBy.length).toBe(1);
    expect(result.repostedBy[0].handle).toBe("test.bsky.social");
  });

  test("getQuotes returns posts", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getQuotes("at://post");
      }).pipe(Effect.provide(makeLayer({ quotes: mockQuotes })))
    );

    const result = await Effect.runPromise(program);
    expect(result.posts.length).toBe(1);
    expect(result.posts[0].author).toBe("test.bsky.social");
  });

  test("getFeedGenerator returns view", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* BskyClient;
        return yield* client.getFeedGenerator("at://feed");
      }).pipe(Effect.provide(makeLayer({ feedGenerator: mockFeedGenerator })))
    );

    const result = await Effect.runPromise(program);
    expect(result.isOnline).toBe(true);
    expect(result.view.displayName).toBe("Test Feed");
  });
});

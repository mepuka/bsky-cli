import { Effect, Stream } from "effect";
import { BskyClient } from "../../src/services/bsky-client.js";
import { BskyError } from "../../src/domain/errors.js";

type BskyClientService = Parameters<typeof BskyClient.of>[0];

type Override = Partial<BskyClientService>;

const unused = () => Effect.fail(BskyError.make({ message: "unused" }));
const emptyStream = () => Stream.empty;

const defaults: BskyClientService = {
  getTimeline: emptyStream,
  getNotifications: emptyStream,
  getFeed: emptyStream,
  getListFeed: emptyStream,
  getAuthorFeed: emptyStream,
  getPost: unused,
  getPostThread: unused,
  getFollowers: unused,
  getFollows: unused,
  getKnownFollowers: unused,
  getRelationships: unused,
  getList: unused,
  getLists: unused,
  getBlocks: unused,
  getMutes: unused,
  getFeedGenerator: unused,
  getFeedGenerators: unused,
  getActorFeeds: unused,
  getLikes: unused,
  getRepostedBy: unused,
  getQuotes: unused,
  resolveHandle: unused,
  resolveIdentity: unused,
  getProfiles: unused,
  searchActors: unused,
  searchFeedGenerators: unused,
  searchPosts: unused,
  getTrendingTopics: unused
};

export const makeBskyClient = (overrides: Override) =>
  BskyClient.make({ ...defaults, ...overrides });

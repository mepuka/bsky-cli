import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { BskyClient } from "../../src/services/bsky-client.js";
import { ProfileResolver } from "../../src/services/profile-resolver.js";
import { BskyError } from "../../src/domain/errors.js";
import { ProfileBasic } from "../../src/domain/bsky.js";

const makeProfile = (did: string, handle: string) =>
  Schema.decodeUnknownSync(ProfileBasic)({ did, handle });

const handleForDid = (did: string) => {
  const token = did.split(":").pop() ?? "user";
  return `${token}.bsky`;
};

describe("ProfileResolver", () => {
  test("batches profile lookups with request resolver", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const bskyLayer = Layer.succeed(
      BskyClient,
      BskyClient.of({
        getTimeline: () => Stream.empty,
        getNotifications: () => Stream.empty,
        getFeed: () => Stream.empty,
        getPost: () => Effect.fail(BskyError.make({ message: "unused" })),
        getProfiles: (actors) => {
          calls.push([...actors]);
          return Effect.succeed(
            actors.map((did) => makeProfile(did, handleForDid(did)))
          );
        }
      })
    );

    const program = Effect.gen(function* () {
      const resolver = yield* ProfileResolver;
      const dids = ["did:plc:one", "did:plc:two"];
      return yield* Effect.forEach(
        dids,
        (did) => resolver.handleForDid(did),
        { batching: true, concurrency: "unbounded" }
      ).pipe(Effect.withRequestBatching(true));
    });

    const results = await Effect.runPromise(
      program.pipe(Effect.provide(ProfileResolver.layer.pipe(Layer.provide(bskyLayer))))
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.slice().sort()).toEqual(["did:plc:one", "did:plc:two"]);
    expect(results.length).toBe(2);
  });

  test("caches repeated lookups", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const bskyLayer = Layer.succeed(
      BskyClient,
      BskyClient.of({
        getTimeline: () => Stream.empty,
        getNotifications: () => Stream.empty,
        getFeed: () => Stream.empty,
        getPost: () => Effect.fail(BskyError.make({ message: "unused" })),
        getProfiles: (actors) => {
          calls.push([...actors]);
          return Effect.succeed(
            actors.map((did) => makeProfile(did, handleForDid(did)))
          );
        }
      })
    );

    const program = Effect.gen(function* () {
      const resolver = yield* ProfileResolver;
      const first = yield* resolver.handleForDid("did:plc:cached");
      const second = yield* resolver.handleForDid("did:plc:cached");
      return { first, second };
    });

    const outcome = await Effect.runPromise(
      program.pipe(Effect.provide(ProfileResolver.layer.pipe(Layer.provide(bskyLayer))))
    );

    expect(calls.length).toBe(1);
    expect(outcome.first).toBe(outcome.second);
  });
});

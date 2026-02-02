import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Either, Layer } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { BskyClient } from "../../src/services/bsky-client.js";
import { IdentityResolver } from "../../src/services/identity-resolver.js";
import { BskyError } from "../../src/domain/errors.js";
import { IdentityInfo } from "../../src/domain/bsky.js";
import { makeBskyClient } from "../support/bsky-client.js";

const envProvider = (entries: Array<readonly [string, string]>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(entries)));

const makeIdentity = (did: string, handle: string) =>
  IdentityInfo.make({ did, handle, didDoc: {} });

describe("IdentityResolver", () => {
  test("persists handle lookups", async () => {
    let calls = 0;
    const bskyLayer = Layer.succeed(
      BskyClient,
      makeBskyClient({
        resolveHandle: (handle) => {
          calls += 1;
          return Effect.succeed(`did:plc:${handle}`);
        },
        resolveIdentity: () =>
          Effect.fail(BskyError.make({ message: "unused" })),
        getProfiles: () => Effect.succeed([])
      })
    );

    const layer = IdentityResolver.layer.pipe(
      Layer.provide(bskyLayer),
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(envProvider([["SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY", "0"]]))
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* IdentityResolver;
        const first = yield* resolver.resolveDid("alice.bsky");
        const second = yield* resolver.resolveDid("alice.bsky");
        return { first, second };
      }).pipe(Effect.provide(layer))
    );

    expect(calls).toBe(1);
    expect(result.first).toBe(result.second);
  });

  test("caches handle not found failures", async () => {
    let calls = 0;
    const notFound = BskyError.make({
      message: "Handle not found",
      error: "HandleNotFound"
    });
    const bskyLayer = Layer.succeed(
      BskyClient,
      makeBskyClient({
        resolveHandle: () => {
          calls += 1;
          return Effect.fail(notFound);
        },
        resolveIdentity: () =>
          Effect.fail(BskyError.make({ message: "unused" })),
        getProfiles: () => Effect.succeed([])
      })
    );

    const layer = IdentityResolver.layer.pipe(
      Layer.provide(bskyLayer),
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(envProvider([["SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY", "0"]]))
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* IdentityResolver;
        const first = yield* resolver.resolveDid("missing.bsky").pipe(Effect.either);
        const second = yield* resolver
          .resolveDid("missing.bsky")
          .pipe(Effect.either);
        return { first, second };
      }).pipe(Effect.provide(layer))
    );

    expect(calls).toBe(1);
    expect(Either.isLeft(result.first)).toBe(true);
    expect(Either.isLeft(result.second)).toBe(true);
  });

  test("strict mode uses resolveIdentity", async () => {
    let resolveHandleCalls = 0;
    let resolveIdentityCalls = 0;
    const bskyLayer = Layer.succeed(
      BskyClient,
      makeBskyClient({
        resolveHandle: () => {
          resolveHandleCalls += 1;
          return Effect.succeed("did:plc:unused");
        },
        resolveIdentity: () => {
          resolveIdentityCalls += 1;
          return Effect.succeed(makeIdentity("did:plc:strict", "alice.bsky"));
        },
        getProfiles: () => Effect.succeed([])
      })
    );

    const layer = IdentityResolver.layer.pipe(
      Layer.provide(bskyLayer),
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(
        envProvider([
          ["SKYGENT_IDENTITY_STRICT", "true"],
          ["SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY", "0"]
        ])
      )
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* IdentityResolver;
        return yield* resolver.resolveDid("alice.bsky");
      }).pipe(Effect.provide(layer))
    );

    expect(result).toBe("did:plc:strict");
    expect(resolveIdentityCalls).toBe(1);
    expect(resolveHandleCalls).toBe(0);
  });

  test("resolveIdentity falls back to resolveHandle when not strict", async () => {
    let resolveHandleCalls = 0;
    let resolveIdentityCalls = 0;
    const bskyLayer = Layer.succeed(
      BskyClient,
      makeBskyClient({
        resolveHandle: (handle) => {
          resolveHandleCalls += 1;
          return Effect.succeed(`did:plc:${handle}`);
        },
        resolveIdentity: () => {
          resolveIdentityCalls += 1;
          return Effect.fail(BskyError.make({ message: "unused" }));
        },
        getProfiles: () => Effect.succeed([])
      })
    );

    const layer = IdentityResolver.layer.pipe(
      Layer.provide(bskyLayer),
      Layer.provide(KeyValueStore.layerMemory),
      Layer.provide(envProvider([["SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY", "0"]]))
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolver = yield* IdentityResolver;
        return yield* resolver.resolveIdentity("alice.bsky");
      }).pipe(Effect.provide(layer))
    );

    expect(result.did).toBe("did:plc:alice.bsky");
    expect(result.handle).toBe("alice.bsky");
    expect(resolveIdentityCalls).toBe(0);
    expect(resolveHandleCalls).toBe(1);
  });
});

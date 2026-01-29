import {
  Config,
  Context,
  Duration,
  Effect,
  Either,
  Layer,
  Option,
  Request,
  RequestResolver
} from "effect";
import { BskyError } from "../domain/errors.js";
import { Handle } from "../domain/primitives.js";
import { BskyClient } from "./bsky-client.js";
import { IdentityResolver } from "./identity-resolver.js";

type CacheConfig = {
  readonly capacity: number;
  readonly timeToLive: Duration.Duration;
};

export class ProfileHandleRequest extends Request.TaggedClass("ProfileHandle")<
  Handle,
  BskyError,
  {
    readonly did: string;
  }
> {}

export class ProfileResolver extends Context.Tag("@skygent/ProfileResolver")<
  ProfileResolver,
  {
    readonly handleForDid: (did: string) => Effect.Effect<Handle, BskyError>;
  }
>() {
  static readonly layer = Layer.effect(
    ProfileResolver,
    Effect.gen(function* () {
      const client = yield* BskyClient;
      const identities = yield* IdentityResolver;

      const batchSizeRaw = yield* Config.integer(
        "SKYGENT_PROFILE_BATCH_SIZE"
      ).pipe(Config.withDefault(25));
      const batchSize = batchSizeRaw <= 0 ? 25 : Math.min(batchSizeRaw, 25);

      const cacheCapacity = yield* Config.integer(
        "SKYGENT_PROFILE_CACHE_CAPACITY"
      ).pipe(Config.withDefault(5000));
      const cacheTtl = yield* Config.duration("SKYGENT_PROFILE_CACHE_TTL").pipe(
        Config.withDefault(Duration.hours(6))
      );
      const strict = yield* Config.boolean("SKYGENT_IDENTITY_STRICT").pipe(
        Config.withDefault(false)
      );

      const cacheConfig =
        cacheCapacity > 0 && Duration.toMillis(cacheTtl) > 0
          ? Option.some<CacheConfig>({ capacity: cacheCapacity, timeToLive: cacheTtl })
          : Option.none<CacheConfig>();

      const cache = yield* Option.match(cacheConfig, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (config) => Request.makeCache(config).pipe(Effect.map(Option.some))
      });

      const resolveBatch = Effect.fn("ProfileResolver.resolveBatch")(
        (requests: ReadonlyArray<ProfileHandleRequest>) =>
          Effect.gen(function* () {
            const dids = Array.from(new Set(requests.map((request) => request.did)));
            if (dids.length === 0) {
              return new Map<string, Either.Either<Handle, BskyError>>();
            }

            const cached = yield* Effect.forEach(
              dids,
              (did) =>
                identities
                  .lookupHandle(did)
                  .pipe(Effect.either, Effect.map((result) => [did, result] as const)),
              { concurrency: "unbounded" }
            );

            const results = new Map<string, Either.Either<Handle, BskyError>>();
            const misses: Array<string> = [];

            for (const [did, result] of cached) {
              if (Either.isLeft(result)) {
                results.set(did, Either.left(result.left));
                continue;
              }
              if (Option.isSome(result.right)) {
                results.set(did, Either.right(result.right.value));
                continue;
              }
              misses.push(did);
            }

            if (misses.length === 0) {
              return results;
            }

            if (strict) {
              const resolved = yield* Effect.forEach(
                misses,
                (did) =>
                  identities
                    .resolveHandle(did)
                    .pipe(Effect.either, Effect.map((value) => [did, value] as const)),
                { concurrency: "unbounded" }
              );
              for (const [did, value] of resolved) {
                results.set(did, value);
              }
              return results;
            }

            const profiles = yield* client.getProfiles(misses);
            for (const profile of profiles) {
              results.set(String(profile.did), Either.right(profile.handle));
            }

            yield* Effect.forEach(
              profiles,
              (profile) =>
                identities.cacheProfile({
                  did: profile.did,
                  handle: profile.handle,
                  source: "getProfiles",
                  verified: false
                }),
              { discard: true, concurrency: "unbounded" }
            );

            return results;
          })
      );

      const resolver = RequestResolver.makeBatched<ProfileHandleRequest, never>(
        (requests) =>
          resolveBatch(requests).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.forEach(requests, (request) => Request.fail(request, error), {
                  discard: true
                }),
              onSuccess: (profileMap) =>
                Effect.forEach(
                  requests,
                  (request) => {
                    const result = profileMap.get(request.did);
                    if (!result) {
                      return Request.fail(
                        request,
                        BskyError.make({
                          message: `Profile not found for DID ${request.did}`,
                          cause: request.did
                        })
                      );
                    }
                    return Either.match(result, {
                      onLeft: (error) => Request.fail(request, error),
                      onRight: (handle) => Request.succeed(request, handle)
                    });
                  },
                  { discard: true }
                )
            })
          )
      ).pipe(RequestResolver.batchN(batchSize));

      const handleForDid = Effect.fn("ProfileResolver.handleForDid")((did: string) => {
        const effect = Effect.request(new ProfileHandleRequest({ did }), resolver);
        return Option.match(cache, {
          onNone: () => effect,
          onSome: (cache) =>
            effect.pipe(
              Effect.withRequestCaching(true),
              Effect.withRequestCache(cache)
            )
        });
      });

      return ProfileResolver.of({ handleForDid });
    })
  );
}

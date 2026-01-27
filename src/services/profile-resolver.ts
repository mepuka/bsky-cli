import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Request,
  RequestResolver
} from "effect";
import { BskyError } from "../domain/errors.js";
import { Handle } from "../domain/primitives.js";
import { BskyClient } from "./bsky-client.js";

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
            const profiles = yield* client.getProfiles(dids);
            return new Map(
              profiles.map((profile) => [String(profile.did), profile.handle])
            );
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
                    const handle = profileMap.get(request.did);
                    return handle
                      ? Request.succeed(request, handle)
                      : Request.fail(
                          request,
                          BskyError.make({
                            message: `Profile not found for DID ${request.did}`,
                            cause: request.did
                          })
                        );
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

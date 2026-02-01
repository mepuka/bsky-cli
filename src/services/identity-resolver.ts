/**
 * Identity Resolver Service
 *
 * Resolves Bluesky handles to DIDs (Decentralized Identifiers) and vice versa.
 * Provides identity resolution with multiple caching layers for performance:
 * - Persistent key-value store cache for long-term caching
 * - In-memory request cache for short-term deduplication
 *
 * Supports various resolution strategies:
 * - Direct handle resolution via resolveHandle API
 * - Identity resolution via resolveIdentity API (with verification)
 * - Profile-based resolution for handles from DIDs
 *
 * Handles edge cases like deactivated DIDs, invalid handles, and not-found errors
 * with appropriate caching to avoid repeated failed requests.
 *
 * @module services/identity-resolver
 */

import * as KeyValueStore from "@effect/platform/KeyValueStore";
import {
  Cache,
  Clock,
  Config,
  Context,
  Duration,
  Exit,
  Effect,
  Layer,
  Option,
  ParseResult,
  Schema
} from "effect";
import { IdentityInfo } from "../domain/bsky.js";
import { BskyError } from "../domain/errors.js";
import { Did, Handle } from "../domain/primitives.js";
import { formatSchemaError, messageFromCause } from "./shared.js";
import { BskyClient } from "./bsky-client.js";

const cachePrefixHandle = "cache/identity/handle/";
const cachePrefixDid = "cache/identity/did/";

const normalizeHandleInput = (value: string) => {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return normalized.toLowerCase();
};

const isHandleInvalid = (handle: Handle) => handle === "handle.invalid";

const toIdentityError = (message: string, operation?: string) => (cause: unknown) =>
  BskyError.make({
    message: messageFromCause(message, cause),
    cause,
    ...(operation ? { operation } : {})
  });

const decodeHandle = (value: string) =>
  Schema.decodeUnknown(Handle)(normalizeHandleInput(value)).pipe(
    Effect.mapError((error) =>
      BskyError.make({
        message: `Invalid handle: ${formatSchemaError(error)}`,
        cause: { handle: value },
        operation: "identityDecodeHandle"
      })
    )
  );

const decodeDid = (value: string) =>
  Schema.decodeUnknown(Did)(value).pipe(
    Effect.mapError((error) =>
      BskyError.make({
        message: `Invalid DID: ${formatSchemaError(error)}`,
        cause: { did: value },
        operation: "identityDecodeDid"
      })
    )
  );

class IdentityCacheEntry extends Schema.Class<IdentityCacheEntry>("IdentityCacheEntry")({
  did: Schema.optional(Did),
  handle: Schema.optional(Handle),
  verified: Schema.Boolean,
  status: Schema.Literal("resolved", "not_found", "deactivated", "invalid"),
  source: Schema.Literal("resolveHandle", "getProfiles", "resolveIdentity"),
  checkedAt: Schema.DateFromString
}) {}

type IdentityStatus = IdentityCacheEntry["status"];

type CacheStores = {
  readonly handleStore: KeyValueStore.SchemaStore<IdentityCacheEntry, never>;
  readonly didStore: KeyValueStore.SchemaStore<IdentityCacheEntry, never>;
};

const cacheKey = (value: string) => encodeURIComponent(value);

const makeCacheStores = (kv: KeyValueStore.KeyValueStore): CacheStores => {
  const store = kv.forSchema(IdentityCacheEntry);
  return {
    handleStore: KeyValueStore.prefix(store, cachePrefixHandle),
    didStore: KeyValueStore.prefix(store, cachePrefixDid)
  };
};

const entryStatusError = (
  status: IdentityStatus,
  identifier: string,
  kind: "handle" | "did"
) => {
  if (status === "not_found") {
    return BskyError.make({
      message:
        kind === "handle"
          ? `Handle not found: ${identifier}`
          : `DID not found: ${identifier}`,
      error: kind === "handle" ? "HandleNotFound" : "DidNotFound",
      operation: kind === "handle" ? "resolveDid" : "resolveHandle"
    });
  }
  if (status === "deactivated") {
    return BskyError.make({
      message: `DID deactivated: ${identifier}`,
      error: "DidDeactivated",
      operation: "resolveHandle"
    });
  }
  return BskyError.make({
    message: `Handle invalid for ${identifier}`,
    error: "HandleInvalid",
    operation: kind === "handle" ? "resolveDid" : "resolveHandle"
  });
};

/**
 * Service for resolving Bluesky identities (handles <-> DIDs).
 *
 * Provides bidirectional resolution between handles and DIDs with comprehensive
 * caching. Lookup methods check cache only, while resolve methods will fetch
 * from the network if not cached.
 */
export class IdentityResolver extends Context.Tag("@skygent/IdentityResolver")<
  IdentityResolver,
  {
    /**
     * Looks up a DID from cache by handle (cache-only, no network request).
     *
     * @param handle - The handle to look up (e.g., "alice.bsky.social")
     * @returns Effect resolving to Option of DID, or BskyError on cache failure
     */
    readonly lookupDid: (handle: string) => Effect.Effect<Option.Option<Did>, BskyError>;

    /**
     * Looks up a handle from cache by DID (cache-only, no network request).
     *
     * @param did - The DID to look up (e.g., "did:plc:...")
     * @returns Effect resolving to Option of Handle, or BskyError on cache failure
     */
    readonly lookupHandle: (did: string) => Effect.Effect<Option.Option<Handle>, BskyError>;

    /**
     * Resolves a handle to a DID, fetching from network if not cached.
     *
     * @param handle - The handle to resolve
     * @returns Effect resolving to DID, or BskyError on resolution failure
     */
    readonly resolveDid: (handle: string) => Effect.Effect<Did, BskyError>;

    /**
     * Resolves a DID to a handle, fetching from network if not cached.
     *
     * @param did - The DID to resolve
     * @returns Effect resolving to Handle, or BskyError on resolution failure
     */
    readonly resolveHandle: (did: string) => Effect.Effect<Handle, BskyError>;

    /**
     * Resolves an identity (handle or DID) to full identity info with verification.
     *
     * @param identifier - The handle or DID to resolve
     * @returns Effect resolving to IdentityInfo with did and handle, or BskyError
     */
    readonly resolveIdentity: (
      identifier: string
    ) => Effect.Effect<IdentityInfo, BskyError>;

    /**
     * Manually caches a profile's identity information.
     *
     * @param input - Object containing did, handle, and optional verified flag and source
     * @returns Effect resolving to void, or BskyError on cache failure
     */
    readonly cacheProfile: (input: {
      readonly did: Did;
      readonly handle: Handle;
      readonly verified?: boolean;
      readonly source?: IdentityCacheEntry["source"];
    }) => Effect.Effect<void, BskyError>;
  }
>() {
  static readonly layer = Layer.effect(
    IdentityResolver,
    Effect.gen(function* () {
      const bsky = yield* BskyClient;
      const kv = yield* KeyValueStore.KeyValueStore;
      const { handleStore, didStore } = makeCacheStores(kv);

      const cacheTtl = yield* Config.duration("SKYGENT_IDENTITY_CACHE_TTL").pipe(
        Config.withDefault(Duration.hours(24))
      );
      const failureTtl = yield* Config.duration("SKYGENT_IDENTITY_FAILURE_TTL").pipe(
        Config.withDefault(Duration.minutes(5))
      );
      const strict = yield* Config.boolean("SKYGENT_IDENTITY_STRICT").pipe(
        Config.withDefault(false)
      );
      const requestCapacity = yield* Config.integer(
        "SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY"
      ).pipe(Config.withDefault(5000));

      const successTtlMs = Duration.toMillis(cacheTtl);
      const failureTtlMs = Duration.toMillis(failureTtl);

      const entryTtl = (entry: IdentityCacheEntry) =>
        entry.status === "resolved" ? cacheTtl : failureTtl;

      const isFresh = (entry: IdentityCacheEntry, now: number) => {
        const ttlMs = Duration.toMillis(entryTtl(entry));
        return ttlMs > 0 && now - entry.checkedAt.getTime() < ttlMs;
      };

      const shouldPersist = (entry: IdentityCacheEntry) =>
        Duration.toMillis(entryTtl(entry)) > 0;

      const readEntry = (
        store: KeyValueStore.SchemaStore<IdentityCacheEntry, never>,
        key: string,
        now: number
      ) =>
        store.get(key).pipe(
          Effect.catchAll((error) =>
            ParseResult.isParseError(error)
              ? Effect.succeed(Option.none())
              : Effect.fail(
                  toIdentityError("Identity cache read failed", "identityCacheRead")(
                    error
                  )
                )
          ),
          Effect.map((cached) =>
            Option.filter(cached, (entry) =>
              isFresh(entry, now) && (!strict || entry.verified)
            )
          )
        );

      const writeEntry = (
        store: KeyValueStore.SchemaStore<IdentityCacheEntry, never>,
        key: string,
        entry: IdentityCacheEntry
      ) =>
        store
          .set(key, entry)
          .pipe(
            Effect.mapError(
              toIdentityError("Identity cache write failed", "identityCacheWrite")
            )
          );

      const writeResolvedEntry = (entry: IdentityCacheEntry) => {
        if (!shouldPersist(entry)) {
          return Effect.void;
        }
        const effects: Array<Effect.Effect<void, BskyError>> = [];
        if (entry.handle) {
          effects.push(
            writeEntry(handleStore, cacheKey(entry.handle), entry)
          );
        }
        if (entry.did) {
          effects.push(writeEntry(didStore, cacheKey(entry.did), entry));
        }
        if (effects.length === 0) {
          return Effect.void;
        }
        return Effect.all(effects, { discard: true });
      };

      const cacheProfile = Effect.fn("IdentityResolver.cacheProfile")(
        (input: {
          readonly did: Did;
          readonly handle: Handle;
          readonly verified?: boolean;
          readonly source?: IdentityCacheEntry["source"];
        }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const entry = IdentityCacheEntry.make({
              did: input.did,
              handle: input.handle,
              verified: input.verified ?? false,
              status: "resolved",
              source: input.source ?? "getProfiles",
              checkedAt: new Date(now)
            });
            yield* writeResolvedEntry(entry);
          })
      );

      const writeNegativeEntry = (
        entry: IdentityCacheEntry,
        target: "handle" | "did",
        key: string
      ) => {
        if (!shouldPersist(entry)) {
          return Effect.void;
        }
        const store = target === "handle" ? handleStore : didStore;
        return writeEntry(store, cacheKey(key), entry).pipe(Effect.asVoid);
      };

      const resolveDidFromCache = (handle: Handle) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* readEntry(handleStore, cacheKey(handle), now);
          if (Option.isNone(cached)) {
            return Option.none<Did>();
          }
          const entry = cached.value;
          if (entry.status === "resolved") {
            return entry.did ? Option.some(entry.did) : Option.none<Did>();
          }
          const identifier =
            entry.status === "deactivated" && entry.did ? entry.did : handle;
          const kind = entry.status === "deactivated" ? "did" : "handle";
          return yield* entryStatusError(entry.status, identifier, kind);
        });

      const resolveHandleFromCache = (did: Did) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* readEntry(didStore, cacheKey(did), now);
          if (Option.isNone(cached)) {
            return Option.none<Handle>();
          }
          const entry = cached.value;
          if (entry.status === "resolved") {
            return entry.handle ? Option.some(entry.handle) : Option.none<Handle>();
          }
          return yield* entryStatusError(entry.status, did, "did");
        });

      const resolveViaResolveIdentity = (identifier: string) =>
        Effect.gen(function* () {
          const info = yield* bsky.resolveIdentity(identifier);
          const now = yield* Clock.currentTimeMillis;
          const invalid = isHandleInvalid(info.handle);
          const entry = IdentityCacheEntry.make({
            did: info.did,
            ...(invalid ? {} : { handle: info.handle }),
            verified: !invalid,
            status: invalid ? "invalid" : "resolved",
            source: "resolveIdentity",
            checkedAt: new Date(now)
          });

          if (invalid) {
            const key = identifier.startsWith("did:") ? info.did : identifier;
            const target = identifier.startsWith("did:") ? "did" : "handle";
            yield* writeNegativeEntry(entry, target, key);
            return yield* entryStatusError("invalid", identifier, target);
          }

          yield* writeResolvedEntry(entry);
          return info;
        }).pipe(
          Effect.catchTag("BskyError", (error) =>
            Effect.gen(function* () {
              if (
                error.error === "HandleNotFound" ||
                error.error === "DidNotFound" ||
                error.error === "DidDeactivated"
              ) {
                const now = yield* Clock.currentTimeMillis;
                const isDid = identifier.startsWith("did:");
                const status =
                  error.error === "DidDeactivated" ? "deactivated" : "not_found";
                const entry = IdentityCacheEntry.make({
                  ...(isDid ? { did: identifier as Did } : { handle: identifier as Handle }),
                  verified: false,
                  status,
                  source: "resolveIdentity",
                  checkedAt: new Date(now)
                });
                yield* writeNegativeEntry(entry, isDid ? "did" : "handle", identifier);
              }
              return yield* error;
            })
          )
        );

      const resolveDidUncached = (handle: Handle) =>
        Effect.gen(function* () {
          const cached = yield* resolveDidFromCache(handle);
          if (Option.isSome(cached)) {
            return cached.value;
          }

          if (strict) {
            const info = yield* resolveViaResolveIdentity(handle);
            return info.did;
          }

          const did = yield* bsky.resolveHandle(handle).pipe(
            Effect.catchTag("BskyError", (error) =>
              Effect.gen(function* () {
                if (error.error === "HandleNotFound") {
                  const now = yield* Clock.currentTimeMillis;
                  const entry = IdentityCacheEntry.make({
                    handle,
                    verified: false,
                    status: "not_found",
                    source: "resolveHandle",
                    checkedAt: new Date(now)
                  });
                  yield* writeNegativeEntry(entry, "handle", handle);
                }
                return yield* error;
              })
            )
          );

          const now = yield* Clock.currentTimeMillis;
          const entry = IdentityCacheEntry.make({
            did,
            handle,
            verified: false,
            status: "resolved",
            source: "resolveHandle",
            checkedAt: new Date(now)
          });
          yield* writeResolvedEntry(entry);
          return did;
        });

      const resolveHandleUncached = (did: Did) =>
        Effect.gen(function* () {
          const cached = yield* resolveHandleFromCache(did);
          if (Option.isSome(cached)) {
            return cached.value;
          }

          if (strict) {
            const info = yield* resolveViaResolveIdentity(did);
            return info.handle;
          }

          const profiles = yield* bsky.getProfiles([did]);
          const profile = profiles[0];
          if (!profile) {
            const error = BskyError.make({
              message: `Profile not found for DID ${did}`,
              error: "ProfileNotFound",
              operation: "getProfiles"
            });
            const now = yield* Clock.currentTimeMillis;
            const entry = IdentityCacheEntry.make({
              did,
              verified: false,
              status: "not_found",
              source: "getProfiles",
              checkedAt: new Date(now)
            });
            yield* writeNegativeEntry(entry, "did", did);
            return yield* error;
          }

          const now = yield* Clock.currentTimeMillis;
          const entry = IdentityCacheEntry.make({
            did,
            handle: profile.handle,
            verified: false,
            status: "resolved",
            source: "getProfiles",
            checkedAt: new Date(now)
          });
          yield* writeResolvedEntry(entry);
          return profile.handle;
        });

      const makeRequestCache = <K, V>(
        lookup: (key: K) => Effect.Effect<V, BskyError>
      ) => {
        if (requestCapacity <= 0 || (successTtlMs <= 0 && failureTtlMs <= 0)) {
          return Effect.succeed(Option.none<Cache.Cache<K, V, BskyError>>());
        }
        return Cache.makeWith({
          capacity: requestCapacity,
          lookup,
          timeToLive: (exit) =>
            Exit.isFailure(exit) ? failureTtl : cacheTtl
        }).pipe(Effect.map(Option.some));
      };

      const resolveDidCache = yield* makeRequestCache(resolveDidUncached);
      const resolveHandleCache = yield* makeRequestCache(resolveHandleUncached);

      const resolveDid = Effect.fn("IdentityResolver.resolveDid")((handle: string) =>
        Effect.gen(function* () {
          const normalized = yield* decodeHandle(handle);
          const effect = Option.match(resolveDidCache, {
            onNone: () => resolveDidUncached(normalized),
            onSome: (cache) => cache.get(normalized)
          });
          return yield* effect;
        })
      );

      const lookupDid = Effect.fn("IdentityResolver.lookupDid")((handle: string) =>
        Effect.gen(function* () {
          const normalized = yield* decodeHandle(handle);
          return yield* resolveDidFromCache(normalized);
        })
      );

      const resolveHandle = Effect.fn("IdentityResolver.resolveHandle")((did: string) =>
        Effect.gen(function* () {
          const normalized = yield* decodeDid(did);
          const effect = Option.match(resolveHandleCache, {
            onNone: () => resolveHandleUncached(normalized),
            onSome: (cache) => cache.get(normalized)
          });
          return yield* effect;
        })
      );

      const lookupHandle = Effect.fn("IdentityResolver.lookupHandle")((did: string) =>
        Effect.gen(function* () {
          const normalized = yield* decodeDid(did);
          return yield* resolveHandleFromCache(normalized);
        })
      );

      const resolveIdentity = Effect.fn("IdentityResolver.resolveIdentity")(
        (identifier: string) =>
          Effect.gen(function* () {
            const normalized = identifier.startsWith("did:")
              ? yield* decodeDid(identifier)
              : yield* decodeHandle(identifier);
            return yield* resolveViaResolveIdentity(normalized);
          })
      );

      return IdentityResolver.of({
        lookupDid,
        lookupHandle,
        resolveDid,
        resolveHandle,
        resolveIdentity,
        cacheProfile
      });
    })
  );
}

# DID Resolution & Persisted Identity Cache Proposal

Date: 2026-01-29

## Context

The CLI currently resolves identities in two places:

- **Handle → DID**: `BskyClient.resolveHandle` calls `com.atproto.identity.resolveHandle` directly and returns a DID with no caching.
- **DID → handle**: `ProfileResolver` calls `app.bsky.actor.getProfiles` in a batched `RequestResolver` with an **in-memory request cache** only (no persistence).

As we add more graph, feed, and engagement features, identity resolution becomes a hot path. We should avoid repeated calls to Bluesky APIs, improve ergonomics, and keep the implementation Effect-idiomatic.

## Goals

- Provide a **read-through, persisted cache** for handle↔DID mappings to reduce API calls across CLI runs.
- Centralize identity resolution behind a **single Effect service** so commands don’t need to care about resolution semantics.
- Keep behavior **deterministic, configurable, and testable** (Effect `Context.Tag` + `Layer`).
- Balance correctness with performance: short-lived negative caches, reasonable TTLs for valid identities.

## Non-goals

- Full DID document validation, PLC audit log validation, or DNS resolution (we continue to rely on PDS APIs).
- Global identity sync via Jetstream/PLC feeds (possible later phase).
- Replacing all profile hydration in one pass; scope is identity resolution + caching.

## References (local)

- `.reference/bsky-docs/docs/advanced-guides/resolving-identities.md`
  - Recommends **identity caches** with a **max TTL of 24 hours** for core identity data and **shorter TTLs (~5 minutes)** for failures.
- `com.atproto.identity.*` lexicons in `.reference/bsky-docs/atproto-openapi-types/lexicons/`:
  - `resolveHandle` (handle → DID)
  - `resolveDid` (DID → DID doc)
  - `resolveIdentity` (handle or DID → DID + verified handle + DID doc)

## Current Code Findings

- `ProfileResolver` uses `Request.makeCache` for in-run caching only (no persistence).
- `KeyValueStore` with filesystem backing is already set up (`src/cli/layers.ts` stores under `${storeRoot}/kv`).
- Existing TTL cache patterns exist in:
  - `src/services/link-validator.ts`
  - `src/services/trending-topics.ts`

These are a good blueprint for a persisted identity cache.

## Proposed Design

### 1) New Service: `IdentityResolver`

Create a new service to centralize identity resolution and caching:

```ts
export class IdentityResolver extends Context.Tag("@skygent/IdentityResolver")<
  IdentityResolver,
  {
    readonly resolveDid: (handle: string) => Effect.Effect<Did, BskyError>
    readonly resolveHandle: (did: string) => Effect.Effect<Handle, BskyError>
    readonly resolveIdentity: (
      identifier: string
    ) => Effect.Effect<IdentityInfo, BskyError>
  }
>() {}
```

- **`resolveDid(handle)`** → uses cache; falls back to `com.atproto.identity.resolveHandle`.
- **`resolveHandle(did)`** → uses cache; falls back to `app.bsky.actor.getProfiles` or `com.atproto.identity.resolveIdentity` (see “Semantics” below).
- **`resolveIdentity(identifier)`** → optional API that returns both sides plus DID doc (future CLI command + debugging).

### 2) Persisted Cache Layout

Use `KeyValueStore` with schema-validated entries and TTL checks:

- Prefix: `cache/identity/handle/` keyed by normalized handle (lowercase).
- Prefix: `cache/identity/did/` keyed by DID string.
- **Key encoding:** use `encodeURIComponent` for both handle and DID keys to avoid filesystem/path edge cases (mirrors `LinkValidator`).

Suggested cache entry model:

```ts
class IdentityCacheEntry extends Schema.Class<IdentityCacheEntry>("IdentityCacheEntry")({
  did: Schema.optional(Did),
  handle: Schema.optional(Handle),
  verified: Schema.Boolean,
  status: Schema.Literal("resolved", "not_found", "deactivated", "invalid"),
  source: Schema.Literal("resolveHandle", "getProfiles", "resolveIdentity"),
  checkedAt: Schema.DateFromString
}) {}
```

- Store **both directions** on successful resolution.
- Store **negative entries** (e.g., handle not found) with shorter TTL.
- If `resolveIdentity` returns `handle.invalid`, record `status = "invalid"` and do **not** treat the handle as resolved.

### 3) TTL Policy (Configurable)

Defaults aligned with Bluesky docs:

- `SKYGENT_IDENTITY_CACHE_TTL` → **24 hours** (positive entries).
- `SKYGENT_IDENTITY_FAILURE_TTL` → **5 minutes** (negative entries).
- Optional: `SKYGENT_IDENTITY_REQUEST_CACHE_CAPACITY` (in-memory request cache for deduping within a run, default 5000).
- **Disabling:** allow TTL or capacity ≤ 0 to disable persisted or in-memory caching (mirrors `ProfileResolver` patterns).

All should use `Effect.Config` and provide overrides via env/config file.

### 4) Resolution Semantics

- **Handle → DID** should always use `resolveHandle`, since it’s the canonical API.
- **DID → handle** has two options:
  1) **Fast path:** `app.bsky.actor.getProfiles` (current behavior). This returns the handle in the profile record (not necessarily verified against the DID doc).
  2) **Strict path (optional):** `com.atproto.identity.resolveIdentity` for verified handle + DID doc.

Recommendation:

- Default to **fast path** for CLI display (ergonomics + speed).
- Add `SKYGENT_IDENTITY_STRICT=true` (or a CLI `--strict-identity` option) to use `resolveIdentity` when correctness matters.
- In strict mode, prefer `resolveIdentity` for **both** handle→DID and DID→handle lookups.
- **Strict cache rule:** when strict mode is on, ignore cache entries with `verified = false` (e.g., those sourced from `getProfiles`).

### 5) Integration Points

- Replace direct calls to `BskyClient.resolveHandle` in CLI commands with `IdentityResolver.resolveDid`.
- Replace `ProfileResolver` usage with `IdentityResolver.resolveHandle` where persisted caching is desired.
- Keep `ProfileResolver` for high-throughput DID→handle batch resolution in jetstream sync if needed, but consider delegating to `IdentityResolver` for cache hits.
- Add `IdentityResolver.layer` to `src/cli/layers.ts`, wired with `KeyValueStore` (persisted cache) and `BskyClient`.

### 6) Error Handling & Negative Caching

- Cache “not found” or “deactivated” responses with a **short TTL** to avoid rapid retry loops.
- Treat unexpected errors as non-cacheable (unless explicitly configured).
- Map KV read/write/decode failures into `BskyError` with a clear `operation` label (consistent with existing services).
- Cache decode failures can be treated as a cache miss (and optionally re-written with a fresh entry).

### 7) Testing

- Provide `IdentityResolver.testLayer` with a `Map`-backed store.
- Add unit tests for TTL logic, negative caching, and read-through behavior.
- Cover `resolveDid` and `resolveHandle` integration with mocked `BskyClient`.

## Performance & Ergonomics Notes

- **Request-level caching** (via `Request.makeCache`) prevents duplicate lookups during a single run; for non-batched lookups, a small `Cache` or request cache can still coalesce concurrent requests.
- **Persisted KV cache** prevents repeated network calls across runs.
- Resolution can be safely parallelized; persist writes should be batched when possible.
- Ensure handle normalization (lowercase) to maximize cache hits.

## Phased Implementation Plan

### Phase 1 — Service & Cache Foundation

- Add `IdentityResolver` service with read-through cache using `KeyValueStore`.
- Implement schema-based cache entries and TTL checks.
- Use `Config` for TTL + capacity options.
- Add test layer + initial tests.

### Phase 2 — CLI Integration

- Update graph commands, search filters, and other identity-sensitive code paths to use `IdentityResolver`.
- Decide whether to deprecate or keep `ProfileResolver` (likely keep for batch lookups; it can be updated to consult the persisted cache first).
- Add optional strict-resolution mode (config or CLI flag).

### Phase 3 — Identity Tools & Proactive Refresh

- Add `skygent identity resolve <handle|did>` command for debugging.
- Add a cache management command (e.g., `skygent cache identity clear|refresh`).
- Explore Jetstream identity events for proactive cache updates (optional).

## Open Questions

1. **Strictness:** should DID→handle default to `resolveIdentity` for verified handles, or keep `getProfiles` for speed? (Proposal: keep `getProfiles` default, allow strict mode.)
2. **Cache scope:** the KV store is global under `${storeRoot}/kv`. This is good for sharing across stores; confirm this is desired.
3. **Negative caching defaults:** recommended TTLs are short (5–15 minutes). Confirm the desired default.

## Next Steps

- Confirm semantics for DID→handle resolution (fast vs strict default).
- Agree on TTL defaults and config names.
- Implement Phase 1 in code and wire into CLI layers.

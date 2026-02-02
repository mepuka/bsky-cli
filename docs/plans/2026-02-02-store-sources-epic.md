# First-Class Store Sources (Epic #148) — Spec (2026-02-02)

Goal: make stores remember and manage their **sources** (authors, feeds, lists, timeline, jetstream) so `sync <store>` / `watch <store>` operate on stored source config rather than ad‑hoc CLI args.

Status: draft (greenfield; no backfill).

Decision: **CLI shape A** — `sync <store>` and `watch <store>` become the primary commands that use stored sources. Existing `sync <source>` / `watch <source>` subcommands remain as explicit one‑offs.

## Goals

1) Persisted source registry per store.
2) Source‑aware sync/watch without repeating CLI arguments.
3) Clean, Effect‑native layering and typed errors.
4) No backfill: existing stores start with empty source lists.

## Non‑goals

- Backfilling sources from historical events.
- Feed/list pruning (requires source attribution on posts).
- Changing existing DataSource semantics or checkpoint keys.

## Data Model

### Domain types

New module: `src/domain/store-sources.ts`

```ts
type StoreSource =
  | AuthorSource
  | FeedSource
  | ListSource
  | TimelineSource
  | JetstreamSource

type AuthorSource = {
  _tag: "AuthorSource"
  actor: Did          // normalized DID (resolved on add)
  display?: Handle    // original handle for UX
  filter?: string     // posts_with_replies / posts_no_replies, etc
  postFilter?: string // DSL filter
  addedAt: Timestamp
  lastSyncedAt?: Timestamp
  enabled: boolean
}

type FeedSource = {
  _tag: "FeedSource"
  uri: AtUri
  filter?: string
  addedAt: Timestamp
  lastSyncedAt?: Timestamp
  enabled: boolean
}

type ListSource = {
  _tag: "ListSource"
  uri: AtUri
  filter?: string
  expandMembers: boolean
  addedAt: Timestamp
  lastSyncedAt?: Timestamp
  enabled: boolean
}

type TimelineSource = { _tag: "TimelineSource", addedAt, lastSyncedAt?, enabled }
type JetstreamSource = { _tag: "JetstreamSource", addedAt, lastSyncedAt?, enabled }
```

### Storage table (per store)

New table in store index DB: `store_sources`

```
id TEXT PRIMARY KEY               -- stable key (type + actor/uri)
type TEXT NOT NULL                -- AuthorSource, FeedSource, ...
source TEXT NOT NULL              -- DID or AtUri
source_json TEXT NOT NULL         -- serialized variant data
added_at TEXT NOT NULL
last_synced_at TEXT               -- nullable
enabled INTEGER NOT NULL DEFAULT 1
```

No backfill; existing stores start empty.

## Services (Effect‑native)

### StoreSources service

`src/services/store-sources.ts` as `Context.Tag("@skygent/StoreSources")`

Operations (all `Effect.fn`):
- `list(store)` → `ReadonlyArray<StoreSource>`
- `get(store, id)` → `Option<StoreSource>`
- `add(store, source)` → `StoreSource` (upsert by id)
- `remove(store, id)` → `void`
- `setEnabled(store, id, enabled)` → `void`
- `markSynced(store, id, at)` → `void`

Implementation:
- Uses `StoreDb.withClient` (same pattern as StoreIndex).
- Uses `SqlSchema` + `Schema.encode/Schema.decode` to persist `config_json`.
- Errors: `StoreIoError` + `StoreSourcesError` (Schema.TaggedError) mapped at boundary.

### Source validation

On `add`:
- Author: resolve handle → DID using `IdentityResolver`.
- Feed/List: verify URI via `BskyClient` (best‑effort).
- Normalize to DID/URI for storage; keep original handle in `display` for UX.

### DataSource mapping

`StoreSources` returns `DataSource[]` for active sources:
- AuthorSource → `DataSource.author(did, { filter, includePins? })`
- FeedSource → `DataSource.feed(uri)`
- ListSource → `DataSource.list(uri)`
- TimelineSource → `DataSource.timeline()`
- JetstreamSource → `DataSource.jetstream()` (if/when supported)

Important: **do not change existing DataSource tags** to preserve checkpoint keys.

## CLI (new)

### Source management

```
skygent store sources <store>
skygent store add-source <store> --author <handle|did> [--filter posts_no_replies] [--post-filter DSL]
skygent store add-source <store> --feed <uri> [--filter DSL]
skygent store add-source <store> --list <uri> [--expand-members] [--filter DSL]
skygent store remove-source <store> <id> [--prune]   # prune only for author
```

Output via `writeJson` / `writeText` consistent with existing CLI conventions.

Note: `--expand-members` is reserved for Phase 4. It is persisted but has no runtime effect yet.

### Sync/watch (primary path)

```
skygent sync <store> [--authors-only|--feeds-only|--lists-only]
skygent watch <store> [--interval ...]
```

Behavior:
- Read active sources from `StoreSources`.
- Run **serial** sync for correctness (Phase 2).
- Per-source errors are captured in the output and do **not** stop other sources.
- `lastSyncedAt` is updated only after a source sync completes successfully.
- Watch reloads the store source registry each cycle so edits are picked up automatically.
- Later optimization: concurrent fetch + serialized writes (see Phase 3).

Existing `sync timeline|author|feed|list` commands remain for one‑off operations.

## Concurrency + Batch Patterns (Effect‑native)

For Phase 3 (bulk sync):
- Introduce a `SyncCoordinator` that:
  - builds per‑source sync effects
  - fetches concurrently (`Effect.forEach` with `concurrency` or `Stream.mapEffect`)
  - serializes writes using an explicit per‑store `Semaphore` (pattern: `StoreDb` client cache)
  - checkpoints only after successful batch writes
- If batching external calls is needed, use `RequestResolver.makeBatched` with `Request.TaggedClass`,
  combine with `RequestResolver.batchN`, and optionally `RequestResolver.dataLoader` (micro‑batching).
Source-level concurrency should use `SyncSettings.concurrency` (env: `SKYGENT_SYNC_CONCURRENCY`).

## Pruning

Phase 2: `store remove-author <store> <did|handle> [--yes]`
- Safe because `posts.author` exists.
- Feed/List prune deferred (needs per‑source attribution).

## Migrations

Add migration `009_store_sources.ts` in `src/db/migrations/store-index/`.
Applied automatically by `StoreDb` migrator.

## Testing

- `StoreSources` service tests: add/list/remove/markSynced.
- CLI tests: `store sources`, `store add-source`, `store remove-source`.
- Sync tests: `sync <store>` uses registered sources and preserves checkpoints.

## Phased Implementation

**Phase 1**
- Domain types + migration + `StoreSources` service.
- CLI: `store sources`, `store add-source`, `store remove-source`.

**Phase 2**
- `sync <store>` and `watch <store>` read from `StoreSources` (serial).
- Author prune.

**Phase 3**
- Concurrent fetch + serialized write coordinator.
- Per‑source `lastSyncedAt` updates.

**Phase 4**
- List expansion (`expandMembers`) and membership reconciliation.

## Open Questions

- None currently. Remaining Phase 3/4 decisions will be tracked here.

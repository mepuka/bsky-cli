# Skygent CLI API Gap Implementation Spec

Date: 2026-01-29
Status: Draft
Owner: TBD
Source: docs/api-gap-analysis.md

## Summary

This spec turns the API gap analysis into an implementation plan for the next CLI read-only features. It focuses on the P1 and P2 gaps first (social graph, lists, feed discovery, engagement drill-down, network search, and liked-post sync), while laying a path for graph-aware filters, local graph caching, and bookmarks. It also documents Effect APIs and data structures to use, with performance and ergonomics tradeoffs.

## Context (Current Architecture)

- REST sources are paginated and pulled via `BskyClient` using `Stream.paginateChunkEffect` and rate-limited retries.
- Parsed posts flow through `SyncEngine` -> `PostParser` -> `FilterRuntime` -> `StoreCommitter` -> SQLite index.
- The store schema is post-only (posts, hashtags, FTS, event log). There is no actor/list/graph storage.
- Filters are mostly post-intrinsic; effectful filters exist (Trending, HasValidLinks).

## Goals

- Cover the P1 and P2 gaps from `docs/api-gap-analysis.md` with stable CLI commands.
- Preserve the current stream-first pipeline and avoid unbounded memory.
- Add a path to graph-aware filters and list membership caching without breaking existing stores.
- Keep behavior predictable and observable (retry, rate limits, clear errors).

## Non-Goals

- Write APIs or moderation/admin endpoints.
- Replacing the existing store model wholesale.
- Full historical graph reconstruction (we do best-effort snapshots).

---

## Proposed CLI Surface (Read-Only)

### Social Graph (P1)

New `graph` command group:

- `graph followers <actor> [--limit N] [--cursor CUR] [--format json|ndjson|table]`
- `graph follows <actor> [--limit N] [--cursor CUR] [--format json|ndjson|table]`
- `graph known-followers <actor> [--limit N] [--cursor CUR] [--format json|ndjson|table]` (auth likely required)
- `graph relationships <actor> --others <csv> [--format json|table]` (uses batch getRelationships)
- `graph lists <actor> [--purpose modlist|curatelist] [--limit N] [--cursor CUR] [--format json|table]`
- `graph list <list-uri> [--limit N] [--cursor CUR] [--format json|table]`
- `graph blocks [--limit N] [--cursor CUR] [--format json|table]` (auth)
- `graph mutes [--limit N] [--cursor CUR] [--format json|table]` (auth)

Notes:
- Output defaults to JSON; NDJSON for large lists.
- Use table format for quick inspection of profiles or list items.

### List Feed as Data Source (P1)

Add list feed to sync/watch:

- `sync list <list-uri> --store <name> [--filter ...]`
- `watch list <list-uri> --store <name> [--filter ...]`

This maps to `app.bsky.feed.getListFeed` and uses the existing post pipeline.

### Feed Discovery (P2)

New `feed` command group:

- `feed show <feed-uri>` (getFeedGenerator)
- `feed batch <feed-uri...>` (getFeedGenerators)
- `feed by <actor> [--limit N] [--cursor CUR]` (getActorFeeds)

### Engagement Drill-Down (P2)

Add `post` subcommands for engagement:

- `post likes <post-uri> [--cid <cid>] [--limit N] [--cursor CUR] [--format json|table]`
- `post reposted-by <post-uri> [--cid <cid>] [--limit N] [--cursor CUR] [--format json|table]`
- `post quotes <post-uri> [--cid <cid>] [--limit N] [--cursor CUR] [--format json|ndjson|table]`

### Network Search (P2)

Use the existing `search posts` command with a `--network` flag to keep the CLI consistent and avoid a new top-level command:

- `search posts <query> --network [--sort top|latest] [--since <date>] [--until <date>] [--author <actor>] [--mentions <actor>] [--lang <lang>] [--domain <domain>] [--url <url>] [--tag <tag>] [--limit N] [--cursor CUR] [--format json|ndjson|table]`

Semantics:
- Exactly one of `--store` (local FTS) or `--network` (remote search) must be provided.
- `--store` is invalid when `--network` is set.
- Output defaults to JSON; `--format ndjson` for streaming.

### Liked Posts Sync (P2)

Add as a post feed source:

- `sync likes <actor> --store <name> [--filter ...]` (auth required; actor must be viewer)
- `watch likes <actor> --store <name> [--filter ...]`

### Bookmarks (P3)

- `sync bookmarks --store <name> [--filter ...]` (auth required)
- Optional `bookmarks list [--limit N] [--cursor CUR] [--format json|table]`

---

## Effect APIs and Implementation Patterns

### Service and Layer Design

- Use `Context.Tag` + `Layer.effect` for new services: `GraphClient` (or extend `BskyClient`), `GraphStore`, `ListStore`.
- Name effectful methods with `Effect.fn` for tracing (call-site spans), following Effect Solutions guidance.

### Pagination and Streams

- Use `Stream.paginateChunkEffect` for paged endpoints (followers, lists, list feed, likes, bookmarks, search posts).
- For CLI output, prefer streaming `NDJSON` via `Stream.runForEach` to avoid memory spikes.
- For table output, collect only when necessary; otherwise show an error for unbounded listing without `--limit`.

### Error Handling

- Add structured errors via `Schema.TaggedError` where new domains are introduced (list/graph/engagement).
- Map API errors to domain errors consistently with `BskyError` patterns.

### Batching and Caching

- `getRelationships` caps `others` at 30; wrap with `RequestResolver.makeBatched` and `RequestResolver.batchN(30)` to avoid N+1.
- Reuse `ProfileResolver` batching when resolving handles or DIDs.

### Effect Graph Module Usage

The Effect Graph module is an in-memory structure with rich traversal APIs. Use it where algorithmic traversal is needed on small/medium graphs:

- Build per-query graphs (followers subgraph, list membership subgraph) and discard after use.
- Use `Graph.mutate` / `beginMutation` to apply many edge updates without copies.
- Use `Graph.bfs`, `Graph.dfs`, or `Graph.topo` for exploration or dependency checks.

Do not use Graph as persistent storage. Store canonical edges in SQLite, and optionally build in-memory Graph slices for hot subsets.

---

## Data Modeling and SQL Considerations

### Post Store (Existing)

List feed, actor likes, and bookmarks are post feeds. These can be ingested into the existing post pipeline with new DataSource variants and no schema change.

Decision: likes and bookmarks are treated as separate stores (not interaction metadata in the primary post store) for simplicity and performance.

Required domain updates:
- `DataSource` union: add `ListFeed`, `Likes`, `Bookmarks` (and any others).
- `EventMeta.source` union: add labels for new sources (for audit/logging).

### Graph and List Storage (New)

To enable graph-aware filters and list membership reuse, add a lightweight graph cache in `index.sqlite`.

Proposed tables (names are suggestions):

```
actors (
  did TEXT PRIMARY KEY,
  handle TEXT,
  display_name TEXT,
  avatar TEXT,
  indexed_at TEXT
)

list_catalog (
  uri TEXT PRIMARY KEY,
  cid TEXT,
  creator_did TEXT,
  name TEXT,
  purpose TEXT,
  description TEXT,
  avatar TEXT,
  list_item_count INTEGER,
  indexed_at TEXT,
  updated_at TEXT
)

list_items (
  list_uri TEXT NOT NULL,
  subject_did TEXT NOT NULL,
  item_uri TEXT,
  indexed_at TEXT,
  PRIMARY KEY (list_uri, subject_did)
)

graph_edges (
  owner_did TEXT NOT NULL,
  target_did TEXT NOT NULL,
  edge_type TEXT NOT NULL, -- follows | followed_by | blocks | mutes
  record_uri TEXT,
  indexed_at TEXT,
  PRIMARY KEY (owner_did, target_did, edge_type)
)
```

Indexes:
- `list_items_subject_idx` on `(subject_did, list_uri)`
- `graph_edges_owner_type_idx` on `(owner_did, edge_type)`
- `graph_edges_target_idx` on `(target_did)`

Why this shape:
- `owner_did` scopes a snapshot to the actor queried (often the viewer), so large graphs are opt-in and bounded by explicit requests.
- `record_uri` keeps links to follow/block records from getRelationships.
- Allows SQL joins for graph-aware filters like `author in list` or `author followed by viewer`.

### Engagement Metadata (Deferred)

If we later need local queries like `liked-by` or `bookmarked`, add tables:

```
post_likes (
  post_uri TEXT NOT NULL,
  actor_did TEXT NOT NULL,
  created_at TEXT,
  indexed_at TEXT,
  PRIMARY KEY (post_uri, actor_did)
)

post_bookmarks (
  post_uri TEXT NOT NULL,
  actor_did TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (post_uri, actor_did)
)
```

Deferred for now since likes/bookmarks are separate stores.

### SQL API Guidance

- Use `sql.in` for list membership and bulk filters, and `sql.and` for composing predicates.
- For ordered inserts or batch upserts, use `SqlResolver.ordered` with `sql.insert`.
- The Bun SQLite client does not support `executeStream`; use pagination for large queries.

---

## Performance and Ergonomics

### API Rate Limits and Pagination

- Respect the existing `BskyClient` rate limit + retry schedule; reuse it for new endpoints.
- Provide `--limit` and `--cursor` on all list-like commands.
- For large datasets (followers, list items), default to NDJSON or require `--limit` unless `--format json` is explicitly requested.

### Output Streaming

- Use `Stream.runForEach` / `writeJsonStream` for NDJSON output.
- Table output should paginate or enforce `--limit` to avoid huge memory usage.

### Graph Caching Strategy

- Avoid full-network graph ingestion. Cache only requested graphs (viewer or specific actor) with TTL or explicit refresh.
- If graph cache grows, provide `graph cache clear` / `graph cache prune` commands (optional).

### Network Search Caveats

- `searchPosts` cursors are not guaranteed to page through all results. Treat them as best-effort.
- Authentication may be required by provider; surface errors clearly.

---

## Phased Implementation Plan

### Phase 0: Foundations (1-2 days)

Work items:
- Add domain schemas for list views, list items, relationships, bookmarks, and engagement views.
  - Files: `src/domain/bsky.ts`, `src/domain/primitives.ts` (if new brands needed).
- Extend `BskyClient` with new endpoints and decoders.
  - Files: `src/services/bsky-client.ts`
  - New method groups:
    - Graph: `getFollowers`, `getFollows`, `getKnownFollowers`, `getRelationships`, `getLists`, `getList`
    - Lists as feed: `getListFeed`
    - Engagement: `getLikes`, `getRepostedBy`, `getQuotes`
    - Feeds: `getFeedGenerator`, `getFeedGenerators`, `getActorFeeds`
    - Search: `searchPosts` (network)
    - Sync sources: `getActorLikes`, `getBookmarks`
- Update error mapping and `BskyError` operation names for new API calls.

Definition of done:
- Each new method returns decoded domain types and supports pagination when applicable.
- All new operations have user-facing, structured errors.

### Phase 1: P1 Social Graph + Lists (3-5 days)

Work items:
- CLI: add `graph` command group and output formatters.
  - Files: `src/cli/search.ts` (table helpers reuse), `src/cli/app.ts`, new `src/cli/graph.ts`
- DataSource: add `ListFeed` variant and update `dataSourceKey`.
  - Files: `src/domain/sync.ts`, `src/domain/events.ts`
- Sync: route list feed to `BskyClient.getListFeed`.
  - Files: `src/services/sync-engine.ts`
- Add table renderers for profiles and list items (reuse `renderTable` pattern).
  - Files: `src/domain/format.ts` or new CLI renderer in `src/cli/graph.ts`

Definition of done:
- `graph followers|follows|lists|list` commands work with pagination and NDJSON.
- `sync list` and `watch list` ingest posts identically to `sync feed`.

### Phase 2: P2 Enrichment (3-5 days)

Work items:
- CLI: add `feed` group + `post` engagement group.
  - Files: `src/cli/feed.ts`, `src/cli/post.ts`, `src/cli/app.ts`
- Network search: add `search posts --network` mode.
  - Files: `src/cli/search.ts`, `src/services/bsky-client.ts`
  - Enforce `--store` xor `--network` validation.
- Likes feed sync: add `Likes` DataSource and sync/watch commands.
  - Files: `src/domain/sync.ts`, `src/services/sync-engine.ts`, `src/cli/sync.ts`, `src/cli/watch.ts`

Definition of done:
- Feed discovery and engagement commands output correct views with pagination.
- Network search uses `searchPosts` and supports `--format ndjson`.
- `sync likes` ingests into separate store and checkpoints correctly.

### Phase 3: P3 Quality-of-Life (2-4 days)

Work items:
- Bookmarks sync in a separate store.
  - Files: `src/domain/sync.ts`, `src/services/sync-engine.ts`, `src/cli/sync.ts`, `src/cli/watch.ts`
- Profile inspection and unread count.
  - Files: `src/cli/profile.ts`, `src/cli/notifications.ts`, `src/services/bsky-client.ts`
- Graph moderation commands.
  - Files: `src/cli/graph.ts`, `src/services/bsky-client.ts`
- Optional: starter packs and suggestions (if time allows).

Definition of done:
- `sync bookmarks` works with auth and cursor checkpoints.
- `profile get` and `notifications unread` return JSON and table output.

### Phase 4: Graph-Aware Filters + SQL Cache (5-8 days)

Work items:
- Add graph cache tables and migrations.
  - Files: `src/db/migrations/store-index/*.ts`, `src/services/store-db.ts`
- Add `GraphStore` service for caching lists + follow edges.
  - Files: `src/services/graph-store.ts` (new), `src/services/store-index.ts` (if queries added)
- Extend filter DSL with graph predicates.
  - Files: `src/domain/filter.ts`, `src/services/filter-compiler.ts`, `src/services/filter-runtime.ts`, `docs/filters.md`
- Add SQL pushdown for `authorInList` via join on `list_items`.
  - Files: `src/services/store-index.ts`
- For complex predicates, resolve author sets via `GraphStore` and evaluate in `FilterRuntime`.

Definition of done:
- Graph predicates are supported in DSL and documented.
- Queries can push down `authorInList` without scanning all posts.

### Phase 5: Follow-on (TBD)

- Identity resolution endpoints (resolveHandle, resolveDid, resolveIdentity).
- Experimental endpoints (postThreadV2, getTrends).

---

## Decisions (2026-01-29)

- Likes and bookmarks are separate stores (no interaction metadata tables in the main store).
- Network search uses `search posts --network` with `--store` xor `--network` validation.

## Open Questions

- Do we scope graph cache to the authenticated viewer by default, or allow arbitrary actor snapshots?
- Should network search results be allowed into the sync pipeline, or remain view-only?
- Do we want to persist list items for all lists seen, or only when explicitly requested?

---

## Acceptance Criteria (Initial)

- P1 graph and list commands return correct data with pagination and clear errors.
- `sync list` works like `sync feed` and stores posts in the same pipeline.
- Feed discovery and engagement commands in P2 return expected views and support NDJSON output.
- No regression in existing sync/query performance.

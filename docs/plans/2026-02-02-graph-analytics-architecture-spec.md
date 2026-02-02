# Graph Analytics + Conversation Grouping — Architecture Spec (2026-02-02)

Goal: deliver a shared, Effect‑native graph analytics layer that supports store analytics (#142), conversation grouping (#143), interaction networks (#144), centrality (#145), community detection (#146), and cross‑store topology (#147) without duplicating logic or violating module boundaries.

Status: draft (architecture + phased plan).

Decision: **Graph snapshots are keyed by DID** (normalize all handles to DID at boundaries).

## Goals

1) Shared graph abstraction reusable across CLI features.
2) Pure graph algorithms isolated from services/IO.
3) Store‑based analytics that scale (SQL pushdown for aggregation).
4) Conversation grouping that avoids full‑store scans.
5) Effect‑native layering and typed errors.

## Non‑goals

- Full “social graph” replication (followers/follows) in the local store.
- Graph ML pipelines (embeddings, LLM clustering) in this phase.
- Backfilling existing stores with thread lineage (greenfield assumption).

## Current Architecture (source references)

### Graph API flow (remote)

- CLI: `src/cli/graph.ts`
- Service: `src/services/bsky-client.ts` (graph endpoints)
- Pure graph builder: `src/graph/relationships.ts`
- Domain types: `src/domain/bsky.ts` (`Relationship`, `RelationshipView`)

Today this path is API‑driven and does **not** read from local stores.

### Store analytics flow (local)

- Service: `src/services/store-stats.ts` (aggregation)
- CLI: `src/cli/digest.ts`
- Store index (SQL + query): `src/services/store-index.ts`, `src/services/store-index-sql.ts`
- Schema/migrations: `src/db/migrations/store-index/*`

Analytics are currently post‑based, not graph‑based.

### Conversation rendering

- CLI query output: `src/cli/query.ts` (thread output)
- Thread rendering: `src/cli/doc/thread.ts`, `src/cli/doc/tree.ts`
- Thread selection (full scan): `src/cli/view-thread.ts`

No indexed thread grouping; full store scans do not scale.

## Findings (from review)

1) **Identity normalization bug** — `buildRelationshipGraph` keys nodes by raw input (`actorKey`) and relationship actor DIDs, so handles and DIDs create duplicate nodes. This will skew centrality/community metrics. (`src/graph/relationships.ts`)
2) **Directed edge bias** — relationships emit a single directed edge even when mutual, which under‑represents reciprocity for algorithms expecting symmetric edges.
3) **Thread grouping lacks index support** — no `reply_parent_uri`/`reply_root_uri` columns, so grouping is currently in‑memory.

## Proposed Shared Graph Abstraction

### Domain types (new)

New module: `src/domain/graph.ts`

```ts
type NodeId = Did

type GraphNode = {
  id: NodeId
  label?: string // handle/display name (optional)
  meta?: Record<string, unknown>
}

type EdgeType =
  | "reply"
  | "quote"
  | "repost"
  | "mention"
  | "follow"
  | "block"
  | "mute"
  | "derived-from"
  | "shared-author"

type GraphEdge = {
  from: NodeId
  to: NodeId
  type: EdgeType
  weight?: number
  meta?: Record<string, unknown>
}

type GraphSnapshot = {
  nodes: ReadonlyArray<GraphNode>
  edges: ReadonlyArray<GraphEdge>
  directed: boolean
  builtAt: Timestamp
  sources: ReadonlyArray<string> // stores or API endpoints
  window?: { start: Timestamp; end: Timestamp }
  filters?: { filterHash?: string }
}
```

### Services (new)

1) **GraphBuilder** (`src/services/graph-builder.ts`)
   - `buildInteractionNetwork(store, options)` → `GraphSnapshot`
   - `buildStoreTopology(stores?)` → `GraphSnapshot`
   - `buildConversationGraph(store, options)` → `GraphSnapshot` (optional)

2) **StoreAnalytics** (`src/services/store-analytics.ts`)
   - `timeBuckets(store, { range, unit, metrics })`
   - Pure SQL `GROUP BY` on `created_date` (day) and `strftime` (hour).

### Pure algorithms (new)

`src/graph/*` (pure, no services):
- `graph-projection.ts` (directed ↔ undirected, weight normalization)
- `graph-centrality.ts` (degree, betweenness, PageRank‑style)
- `graph-communities.ts` (Louvain/label propagation on undirected graphs)
- `conversation.ts` (thread tree assembly from post edges)

### Effect‑native patterns

- Services follow `Context.Tag` with `.layer` and `Effect.fn("Service.method")`.
- Use `Layer.effect` for deps, `Layer.scoped` when a scope is required (e.g., persistence stores).
- Keep graph algorithms pure to avoid hidden effects; services only fetch/build snapshots.
- Use `Schema.Class` / `Schema.TaggedClass` for domain types and error types (`Schema.TaggedError`).

## Required Schema + Index Changes

### Conversation grouping (for #143)

Add to `posts` table:
- `reply_parent_uri TEXT`
- `reply_root_uri TEXT`

Migration: new file in `src/db/migrations/store-index/`.

Index these columns for grouping and recursive CTE expansion:
- `CREATE INDEX posts_reply_parent_idx ON posts(reply_parent_uri)`
- `CREATE INDEX posts_reply_root_idx ON posts(reply_root_uri)`

Populate in `src/services/store-index-sql.ts`:
- `reply_parent_uri = post.reply?.parent.uri`
- `reply_root_uri = post.reply?.root.uri`

### Optional: hourly bucket column (for #142)

If needed for faster hourly analytics:
- `created_hour TEXT` (e.g., `YYYY‑MM‑DDTHH:00:00Z`)
- index on `created_hour`

## CLI + Output Changes

### New command (Issue #142)

`skygent store analytics <store> [--range ...] [--unit day|hour] [--metrics posts|authors|likes|reposts|replies|quotes|engagement]`

Output: `json` by default; supports `table` + `ndjson` (optional).

### Query threading (Issue #143)

`skygent query <store> --format thread [--thread-context matches|ancestors|full]`

Implementation: use `StoreIndex.threadGroups` (new) and `renderThread`.

## Effect‑native Implementation Plan (phases)

**Phase 0 — Shared graph contract + fixes (1–2 days)**
- Add `src/domain/graph.ts` types.
- Add `GraphBuilder` service skeleton (no heavy algorithms yet).
- Fix identity normalization in `src/graph/relationships.ts` (resolve handle → DID before build).
- Update tests in `tests/graph/relationships.test.ts` for handle/DID normalization and mutual edges.

**Phase 1 — Store analytics (#142)**
- Implement `StoreAnalytics` service (SQL `GROUP BY`).
- Add CLI `store analytics` command.
- Tests: `tests/services/store-analytics.test.ts` + CLI snapshots.

**Phase 2 — Conversation grouping (#143)**
- Add reply columns + migration + `store-index-sql` write logic.
- Implement `StoreIndex.threadGroups` (SQL query or CTE).
- Update `query --format thread` to render per‑root groups with counts.
- Tests: thread grouping with matches/ancestors.

**Phase 3 — Interaction network (#144)**
- Implement `GraphBuilder.buildInteractionNetwork` using store posts (reply/mention/quote/repost).
- Add CLI `graph interactions` (or `store graph`) to output `GraphSnapshot`.
- Tests: known small graph (3–5 posts) with deterministic edges.

**Phase 4 — Centrality (#145)**
- Implement `graph-centrality.ts` (degree, weighted degree, PageRank‑lite).
- CLI `graph centrality` for a store or snapshot (json output).

**Phase 5 — Community detection (#146)**
- Implement `graph-communities.ts` using undirected projection + label propagation.
- CLI `graph communities` with `--min-size` + `--max` options.

**Phase 6 — Cross‑store topology (#147)**
- Build store‑level graph from `LineageStore` + `StoreSources`.
- CLI `graph stores` (topology + summary metrics).

## Open Questions

1) Should we cache graph snapshots (`GraphCache` service using KeyValueStore)?
2) Should interaction edges include time windows by default?
3) Which centrality algorithms are in scope (degree + PageRank only vs betweenness)?
4) Do we want to expose graph output as `mermaid` (reuse `relationshipMermaid`)?

## References (primary code)

- Graph API: `src/cli/graph.ts`, `src/graph/relationships.ts`, `src/services/bsky-client.ts`
- Store analytics: `src/services/store-stats.ts`, `src/cli/digest.ts`
- Store index: `src/services/store-index.ts`, `src/services/store-index-sql.ts`
- Query threads: `src/cli/query.ts`, `src/cli/doc/thread.ts`, `src/cli/view-thread.ts`
- Domain types: `src/domain/bsky.ts`, `src/domain/post.ts`, `src/domain/events.ts`

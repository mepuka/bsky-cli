# Issues + SQLite Optimization Deep Dive Spec

Date: 2026-01-29
Status: Draft
Owner: TBD

## Summary

This document deep-dives the current open GitHub issues and proposes a phased implementation plan to fix correctness bugs and improve query/storage performance. It assumes greenfield operation: we can freely change schemas and rebuild the SQLite index without data migrations or backwards compatibility guarantees.

## Context (Current Architecture)

- Stores write to a per-store SQLite `index.sqlite` via `StoreDb` + migrations in `src/db/migrations/store-index`.
- `StoreCommitter` updates the `posts` table and writes an append-only `event_log` with `PostEventRecord` payloads.
- `StoreIndex.query` paginates posts by `created_at` and returns full `Post` objects by decoding `post_json`.
- Filters are evaluated in JS (`FilterRuntime`), outside the database, in `query` and `materialize` workflows.
- Query output formats other than ndjson currently collect the entire stream before rendering.
- `store stats` reads directly from `posts` and `post_hashtag` tables, without forcing `StoreIndex` bootstrap.

## Goals

- Fix correctness bugs (#38, #39, #40, #41) and improve UX (#43, #47).
- Introduce SQL pushdown for filters (#46) and FTS5-based text search (#45).
- Provide performance-focused query pipeline (streaming output, progress reporting, smarter limits).
- Extend CLI with query sort order (#42) and new discovery/search capabilities (#44, #31).
- Add store lock wait handling (#37).
- Define a phased plan with clear dependencies and acceptance criteria.

## Non-Goals

- Data migration or backward compatibility for previous schemas.
- Cross-store global indices or multi-tenant SQLite layout.

## Greenfield Assumption

- We can change table schemas, add FTS5 virtual tables, and drop/rebuild index tables as needed.
- Existing stores may be rebuilt from `event_log` or re-synced.

## Effect Source Review (Idiomatic Patterns + API References)

This section anchors the implementation plan in Effect-native patterns found in the Effect monorepo. All references below point to local Effect source or package docs.

### Services, Layers, and Tracing

- Use `Context.Tag` for service contracts and pair with `Layer.scoped` / `Layer.succeed` for resource-safe, composable wiring.
  Sources: `/.reference/effect/packages/effect/src/Context.ts#L513`, `/.reference/effect/packages/effect/src/Layer.ts#L730`
- Use `Effect.fn` for named, traced effects (call-site tracing + spans) when adding new service methods or long-running operations.
  Source: `/.reference/effect/packages/effect/src/Effect.ts#L14487`

Engineering justification:
- This matches Effect's idiomatic dependency injection model and provides structured tracing for performance-sensitive paths (query pipeline, sync, and index rebuilds).

### Stream-first Query Pipeline

- Pagination should remain `Stream.paginateChunkEffect`, which is explicitly designed for page-based sources and is already used in `StoreIndex.query`.
  Source: `/.reference/effect/packages/effect/src/Stream.ts#L3380`
- Apply filter and projection via `Stream.filterEffect` and `Stream.mapEffect` (effectful predicates and decoding).
  Sources: `/.reference/effect/packages/effect/src/Stream.ts#L1636`, `/.reference/effect/packages/effect/src/Stream.ts#L2896`
- Apply `--limit` with `Stream.take` after filtering to guarantee correctness.
  Source: `/.reference/effect/packages/effect/src/Stream.ts#L4785`
- For streaming output, prefer `Stream.runForEach` / `Stream.runForEachChunk` instead of `Stream.runCollect` to avoid unbounded memory growth.
  Sources: `/.reference/effect/packages/effect/src/Stream.ts#L4285`, `/.reference/effect/packages/effect/src/Stream.ts#L4109`
- Use `Stream.groupedWithin` + `Stream.scan` + `Stream.tap` to emit periodic progress metrics without altering the data stream.
  Sources: `/.reference/effect/packages/effect/src/Stream.ts#L2400`, `/.reference/effect/packages/effect/src/Stream.ts#L4513`, `/.reference/effect/packages/effect/src/Stream.ts#L4905`
- Use `Stream.runForEachWhile` for bounded streaming when we need to stop after emitting `--limit` results with side effects.
  Source: `/.reference/effect/packages/effect/src/Stream.ts#L4350`

Engineering justification:
- These combinators are first-class in `Stream` and map cleanly to our streaming requirements (progress feedback, incremental output, bounded memory).

### SQL Construction + Typed Decoding

- Use `SqlClient.SqlClient` + template tag interpolation for SQL with parameterization, `sql.in` for list filters, and `sql.and` for composed predicates.
  Source: `/.reference/effect/packages/sql/README.md`
- For ordering, `sql.unsafe` is the sanctioned escape hatch (only with whitelisted values).
  Source: `/.reference/effect/packages/sql/README.md`
- Continue using `SqlSchema.findAll` / `findOne` / `void` for typed row decoding and error mapping.
  Source: `/.reference/effect/packages/sql/README.md`
- Prefer `SqlResolver.findById` / `SqlResolver.ordered` when we need batched lookups or bulk inserts with schema-level validation.
  Source: `/.reference/effect/packages/sql/README.md`
- SQLite Bun client does not implement `executeStream`, so streaming queries should remain pagination-based.
  Source: `/.reference/effect/packages/sql-sqlite-bun/src/SqliteClient.ts#L120`
- WAL is enabled by default in the Bun SQLite client unless `disableWAL` is set.
  Source: `/.reference/effect/packages/sql-sqlite-bun/src/SqliteClient.ts#L90`

Engineering justification:
- This keeps SQL interpolation safe, preserves typed row parsing, and aligns with SQLite Bun's capabilities.

### Migrations + Schema Evolution

- Migrations are `Effect` default exports and executed via the Effect SQL `Migrator` pipeline.
  Source: `/.reference/effect/packages/sql/README.md`
- `Migrator` uses `sql.onDialectOrElse` and executes migrations inside a transaction; defects are translated via `Effect.catchAllDefect` and `Effect.orDieWith`.
  Source: `/.reference/effect/packages/sql/src/Migrator.ts#L130`

Engineering justification:
- This is the canonical Effect SQL migration workflow and makes schema changes safe and deterministic for a greenfield DB.

### Error Modeling + Mapping

- Use `Schema.TaggedError` to model domain errors with tagged variants and structured fields.
  Source: `/.reference/effect/packages/effect/src/Schema.ts#L8810`
- Map lower-level errors to domain errors using `Effect.catchTags` (multi-tag mapping) and related patterns.
  Source: `/.reference/effect/packages/platform/src/Multipart.ts#L520`
- For JSON payloads stored in SQLite, `Schema.parseJson` provides validated parse/encode transformations.
  Source: `/.reference/effect/packages/effect/src/Schema.ts#L4815`
- For migrations and other infra errors, `Effect.catchAllDefect` and `Effect.orDieWith` are used to convert defects into typed errors.
  Source: `/.reference/effect/packages/sql/src/Migrator.ts#L130`

Engineering justification:
- Tagged errors keep CLI output consistent, while structured parsing avoids latent runtime failures during query/format operations.

### CLI + Printer Integration

- `@effect/cli` provides built-in options including `--completions` for shell completion generation and built-in help/version handling.
  Source: `/.reference/effect/packages/cli/README.md`
- The printer stack composes `Doc` into `DocStream`, then renders to output; this aligns with our existing `Doc` rendering in query formats.
  Source: `/.reference/effect/packages/printer/README.md`

Engineering justification:
- We can implement #12 using the built-in `--completions` support rather than custom scripts, and keep CLI formatting consistent with Effect's printer pipeline.

### Scheduling and Retries (Store Lock Waiting)

- Use `Schedule.spaced` or `Schedule.exponential` with `Effect.retry` to implement `--wait` semantics for store locks.
  Sources: `/.reference/effect/packages/effect/src/Schedule.ts#L1757`, `/.reference/effect/packages/effect/src/Schedule.ts#L980`

Engineering justification:
- Schedules are the idiomatic Effect mechanism for retry/backoff and will keep lock waiting deterministic and testable.

## Issue Deep Dives

### #38 - `--limit` constrains DB fetch, not output

**Current behavior**
- `StoreQuery.limit` is applied as SQL `LIMIT` in `StoreIndex.query`.
- Filters are applied after DB fetch in `cli/query.ts`, so `--limit` only limits the scan window, not matched results.

**Root cause**
- Query limit is applied before filter evaluation (JS side), leading to empty results for selective filters.

**Proposed fix**
- Separate `scanLimit` (SQL fetch cap) from `limit` (results cap).
- Apply `limit` after filter evaluation: `Stream.take(limit)`.
- Add `--scan-limit` option for power users; default to unlimited or a safe heuristic when filtering.

**Design notes**
- Update `StoreQuery` to include `scanLimit?: number` and `order?: "asc" | "desc"` (also required for #42).
- `StoreIndex.query` accepts `scanLimit` for DB paging, but does not enforce `limit`.
- Query pipeline applies `Stream.take(limit)` after filter evaluation and projection.

**Acceptance criteria**
- `query --filter ... --limit 15` returns 15 matches (if available), regardless of earliest rows.
- `--scan-limit` bounds DB scanning without affecting correctness (unless too low to find matches).

---

### #39 - Filtered queries hang for minutes on large stores

**Current behavior**
- Filtered queries with `card`/`thread` formats call `Stream.runCollect`, holding all posts in memory.
- All posts are JSON-decoded and filtered in JS; no SQL pushdown.

**Root cause**
- Collect-then-render, plus JS-only filtering and decoding, make large stores slow and memory-heavy.

**Proposed fix**
- Enable streaming output where possible (compact, card) and optional progress reporting.
- Push down filter predicates to SQL where possible (#46).
- Introduce FTS5 for `contains`/`regex` (#45) and add indexed columns to avoid JSON parsing for non-matching rows.

**Design notes**
- For `compact` and `card`, render per post and write to stdout incrementally.
- For `thread`/`table`/`markdown`, retain collection, but add warnings or require explicit `--limit` for large result sets.
- Add progress updates on stderr every N rows or time interval.

**Acceptance criteria**
- Filtered queries on 20k+ posts show progress within 1s and return results without multi-minute hangs.
- Memory usage stays bounded for streaming formats.

---

### #40 - Jetstream filter counts delete events as postsAdded

**Current behavior**
- Jetstream delete commits are stored and counted as `postsAdded`.
- Content filters evaluate only on upserts; deletes bypass filter but still increment added count.

**Root cause**
- `SyncResult` only tracks `postsAdded` and `postsSkipped`. Deletes are not separated.

**Proposed fix**
- Extend `SyncResult` to include `postsDeleted`.
- For `CommitDelete`, increment `postsDeleted` (not `postsAdded`).
- Optionally expose `--include-deletes` flag to count delete events separately or include them in output.

**Design notes**
- Update `domain/sync.ts` and CLI output format to include `postsDeleted`.
- Jetstream sync should return `{ postsAdded, postsDeleted, postsSkipped, errors }`.

**Acceptance criteria**
- Delete-only streams report `postsDeleted > 0`, `postsAdded = 0`.

---

### #41 - `store stats` reports 0 posts until query triggers bootstrap

**Current behavior**
- `store stats` reads from `posts` table directly.
- If `posts` is empty but `event_log` has data, stats show 0 until a query triggers bootstrap.

**Root cause**
- Stats bypasses `StoreIndex` bootstrapping logic.

**Proposed fix**
- If `posts` is empty and `event_log` has data, trigger bootstrap or compute stats from event_log.

**Design notes**
- Preferred: call `StoreIndex.count()` (which bootstraps) or explicitly call `StoreIndex.rebuild()` if needed.
- Maintain a `bootstrapIfNeeded` helper shared by stats and query paths.

**Acceptance criteria**
- `store stats` after sync shows correct counts without manual query.

---

### #42 - Add descending sort (--sort desc / --newest-first)

**Current behavior**
- Queries are ordered ascending by `created_at`.

**Proposed fix**
- Add `--sort asc|desc` option (alias `--newest-first`).
- Extend `StoreQuery` to carry sort order.
- Update SQL to `ORDER BY created_at ASC|DESC`.

**Acceptance criteria**
- Descending order returns newest posts first in all formats.

---

### #43 - Cryptic error messages for invalid handles / API failures

**Current behavior**
- Handle validation errors often surface as low-level schema parse errors.
- API errors from ATProto may bubble up with unhelpful messages.

**Root cause**
- Error formatting is inconsistent across CLI layers.

**Proposed fix**
- Introduce a shared `formatBskyError` and `formatHandleError` in CLI error pipeline.
- When schema validation fails for handles or DIDs, provide actionable examples.
- When API requests fail, surface status code and error detail from response payload.

**Design notes**
- Extend `cli/errors.ts` to map `BskyError` into friendly messages with context.
- Add examples for common mistakes (`handle` missing domain, invalid characters, etc.).

**Acceptance criteria**
- Invalid handle errors always include a short fix suggestion.
- API errors include status code and endpoint context.

---

### #44 - Add search command for discovering handles and feeds

**Current behavior**
- No CLI command for discovery.

**Proposed fix**
- Add `skygent search` subcommands:
  - `search handles <query>` (actors search)
  - `search feeds <query>` (feed generator search)

**Design notes**
- Extend `BskyClient` with methods for search endpoints.
- Output formats: `table`, `json`, `ndjson`.

**Acceptance criteria**
- Simple search commands return results with handle/displayName/description.

---

### #45 - Add FTS5 full-text search index for post content

**Current behavior**
- `contains` and `regex` filters run in JS by scanning decoded `post_json`.

**Proposed fix**
- Add FTS5 table (contentless or external content) on post `text` (and optionally `author`, `lang`).
- Use `MATCH` to satisfy `contains`/`regex` where possible.

**Design notes**
- Suggested schema (contentless for simplicity):
  - `CREATE VIRTUAL TABLE posts_fts USING fts5(uri, text, tokenize='porter unicode61');`
  - Keep `uri` as join key to `posts`.
- Maintain FTS entries in `upsertPost` and delete on `deletePost`.
- Add migration `003_fts.ts` and update rebuild flow to populate FTS.

**Acceptance criteria**
- `contains:"word"` queries complete in seconds on 20k+ posts.
- FTS table stays in sync with `posts` updates/deletes.

---

### #46 - Push filter predicates to SQL WHERE clauses

**Current behavior**
- All filters are evaluated in JS (`FilterRuntime`).

**Proposed fix**
- Implement a SQL query planner that extracts pushdown-able filters and returns:
  - `sqlWhere`, `params`, `joins`, and remaining JS filter expression.

**Design notes**
- Pushdown candidates (Phase 1):
  - `Author`, `AuthorIn` -> `posts.author IN (...)`
  - `Hashtag`, `HashtagIn` -> join `post_hashtag`.
  - `DateRange` -> `created_at BETWEEN ...`.
  - `Contains`/`Regex` -> `posts_fts MATCH ...` (Phase 2).
- Non-pushdown: `HasLinks`, `HasMedia`, `HasValidLinks`, `Trending`, `Engagement` (until columns exist).
- `StoreIndex.query` to accept an optional `sqlFilter` (compiled from `FilterExpr`).
- JS predicate applied only to the residual filter expression.

**Acceptance criteria**
- SQL pushdown reduces rows scanned for common filters.
- Query results remain correct with combined SQL+JS filters.

---

### #47 - No progress feedback during long-running filtered queries

**Current behavior**
- Query is silent until completion.

**Proposed fix**
- Add progress reporting for queries that exceed a time threshold or use filters.

**Design notes**
- Emit to stderr every 1s or every N scanned rows.
- Metrics: scanned rows, matched rows, elapsed, rate, estimated time if scan limit known.
- Optional flag `--progress` (on by default for filtered queries).

**Acceptance criteria**
- Users see progress output during long-running queries.

---

### #37 - Add --wait <duration> for store locks

**Current behavior**
- Store lock acquisition fails immediately with "Store is busy".

**Proposed fix**
- Add `--wait <duration>` to commands that lock stores (sync/watch/derive).
- Implement retry loop with jitter until timeout.

**Design notes**
- `StoreLock.withStoreLock` can accept `waitFor` duration and a retry schedule.
- Return a friendly timeout error after duration expires.

**Acceptance criteria**
- `--wait 30s` blocks until lock is available or times out.

---

### #31 - Add search posts command for full-text post discovery

**Current behavior**
- Users must use `query --filter contains:"..."` for search.

**Proposed fix**
- Add `skygent search posts <store> --text "..."` backed by FTS5.
- Provide `--limit`, `--sort`, and `--format` options.

**Design notes**
- Alias to `query` with prebuilt FTS filter for now.

**Acceptance criteria**
- Post search returns top matches quickly using FTS.

---

### #32 - Add sync likes command for engagement attribution

**Current behavior**
- No way to ingest like events for engagement metadata.

**Proposed fix**
- Add a new sync source that fetches likes and stores them in a new store or enrichment table.

**Design notes**
- Requires new schema (likes table) and enrichment in `posts` or related store.
- Use ATProto endpoints for likes and maintain checkpointing.

**Acceptance criteria**
- `sync likes` produces deterministic results with checkpointing.

---

### #30 - Add Follow graph store for relationship tracking

**Proposed fix**
- Introduce `follow_graph` store with `follows` table (actor -> actor) and timestamps.
- Provide sync command and query capabilities.

---

### #29 - Add Profile store with dedicated domain model and storage

**Proposed fix**
- Create profile store schema for profile snapshots.
- Provide sync and query operations.

---

### #12 - Add shell autocomplete support

**Proposed fix**
- Add `skygent completion <shell>` command.
- Wire to CLI framework if supported; otherwise add a static completion generator.

---

## SQLite Optimization Strategy (from docs review)

**Connection PRAGMAs (set on open)**
- `PRAGMA journal_mode=WAL;`
- `PRAGMA synchronous=NORMAL;`
- `PRAGMA temp_store=MEMORY;`
- `PRAGMA cache_size=-8000;` (approx 8MB; tune later)
- `PRAGMA mmap_size=268435456;` (256MB; tune per platform)
- `PRAGMA optimize;` (on close or after bulk ingestion)

**Query planning**
- Run `ANALYZE` after large syncs or rebuilds.
- Use `EXPLAIN QUERY PLAN` during development to ensure indexes are used.

**Indexing**
- Add indexes for any new columns used in SQL filters (author, created_at, has_media, etc.).
- Ensure `post_hashtag.tag` has an index (already present).

## Proposed Schema Extensions (Greenfield)

1. Add derived columns to `posts` table:
   - `text`, `lang`, `is_reply`, `is_quote`, `is_repost`, `is_original`, `has_links`, `has_media`, `has_images`, `has_video`, `like_count`, `repost_count`, `reply_count`.
2. Add `post_lang` join table if language filtering is common.
3. Add FTS5 virtual table for post text (contentless or external content).

## Phased Implementation Plan

### Phase 0: Correctness + UX fixes (1-2 days)
- #38: move `--limit` to post-filter stage; add `--scan-limit`.
- #40: separate `postsDeleted` from `postsAdded` in Jetstream results.
- #41: bootstrap or rebuild before stats; route stats through `StoreIndex`.
- #43: improve error formatting for invalid handles / API failures.
- #47: add progress output for filtered queries.
- #37: add `--wait` support for store locks.

### Phase 1: Query pipeline improvements (2-4 days)
- #42: add `--sort asc|desc` and `--newest-first`.
- #46: implement SQL pushdown for Author/Hashtag/DateRange.
- Stream output for `compact` and `card` formats; warn or require `--limit` for `thread`/`table`.
- Add query planner and residual JS filtering.

### Phase 2: SQLite performance + FTS (3-6 days)
- #45: add FTS5 virtual table and maintain it in upsert/delete.
- Add derived columns in `posts` table; update upsert logic.
- Add `ANALYZE` + `PRAGMA optimize` hooks after rebuild or large sync.

### Phase 3: Discovery + search features (4-6 days)
- #44: `search handles` + `search feeds` CLI.
- #31: `search posts` backed by FTS.
- Add JSON/NDJSON/table output formats for search.

### Phase 4: New stores and enrichment (TBD)
- #32: sync likes pipeline.
- #30: follow graph store.
- #29: profile store.
- #12: shell completion support.

## Testing Plan (cross-cutting)

- Query correctness: `--filter` + `--limit` returns correct count regardless of scan order.
- Performance: large store queries with filters complete quickly with progress output.
- FTS correctness: matches expected posts; deletes remove entries.
- Sync results: delete-only batches increment `postsDeleted` not `postsAdded`.
- Stats: shows correct counts without prior query.
- Lock wait: `--wait` respects timeout.

## Open Questions

- Should default `--scan-limit` be finite for filtered queries to avoid long scans?
- Should `thread` format enforce a max `--limit` by default?
- For FTS5, choose tokenizer and ranking strategy (default bm25 vs custom).
- How to expose `postsDeleted` in JSON output and progress logs?

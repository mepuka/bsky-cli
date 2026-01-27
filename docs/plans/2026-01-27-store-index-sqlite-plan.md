# StoreIndex SQLite Backend Plan (Effect SQL)

Date: 2026-01-27
Status: Draft for review

## Goals

- Replace KV-based StoreIndex with a SQLite-backed implementation to remove O(N) list writes and improve query scalability.
- Use Effect SQL primitives (SqlClient, SqlSchema, Migrator) for typed, Effect-idiomatic data access.
- Keep StoreIndex public API stable.
- Preserve agentic workflows while improving correctness and performance.

## Key Effect SQL Building Blocks (from .reference/effect)

- `@effect/sql`:
  - `SqlClient` tagged template (`sql\`...\``), `sql.insert(...)`, `sql.update(...)`.
  - `SqlSchema.findAll/findOne/void/single` for request/response validation.
  - `SqlClient.withTransaction` for atomic write sequences.
  - `Migrator` + `Migrator/FileSystem` for schema migrations.
- `@effect/sql-sqlite-bun`:
  - `SqliteClient.layer` / `SqliteClient.make` to create a Bun-backed SQLite client.
  - Uses `bun:sqlite` internally; WAL enabled by default.

## Storage Layout Decision

Recommended: **Per-store SQLite DB file**.

Rationale:
- Aligns with store-level isolation and existing per-store locking.
- Simplifies deletes (delete DB file or clear tables for that store).
- Avoids cross-store contention inside a single DB file.

Proposed path:
- `dbPath = path.join(config.storeRoot, store.root, "index.sqlite")`
- Ensure `store.root` directory exists before opening DB.

Alternative (not chosen):
- Single global DB with `store_name` column in every table.

## Schema Design

Single database per store, with normalized tables.

### Table: posts

Stores full Post JSON and indexed columns for query performance.

```sql
CREATE TABLE IF NOT EXISTS posts (
  uri TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_date TEXT NOT NULL,
  author TEXT,
  post_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_created_date_idx ON posts(created_date);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at);
CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author);
```

### Table: post_hashtag

Join table for hashtag -> uri lookups.

```sql
CREATE TABLE IF NOT EXISTS post_hashtag (
  uri TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (uri, tag),
  FOREIGN KEY (uri) REFERENCES posts(uri) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS post_hashtag_tag_idx ON post_hashtag(tag);
```

### Table: index_checkpoints

```sql
CREATE TABLE IF NOT EXISTS index_checkpoints (
  index_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_event_id TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

Notes:
- `created_at` and `updated_at` stored as ISO strings.
- `created_date` stored as `YYYY-MM-DD` for fast date bucketing.
- Use `PRAGMA foreign_keys = ON` after opening the DB to enforce cascades.

## Migrations

Use `@effect/sql/Migrator` with filesystem loader.

- Directory: `src/db/migrations/store-index`
- File naming: `001_init.ts`, `002_add_index_...ts`
- Each migration exports default `Effect` using `SqlClient`:

```ts
// 001_init.ts (sketch)
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS posts (...)`;
  yield* sql`CREATE TABLE IF NOT EXISTS post_hashtag (...)`;
  yield* sql`CREATE TABLE IF NOT EXISTS index_checkpoints (...)`;
  yield* sql`CREATE INDEX IF NOT EXISTS ...`;
});
```

Use `Migrator.fromFileSystem(directory)` + `Migrator.make(...)` to run at DB open time.

## Service and Layer Design

### New service: StoreIndexSqlite

Implements the existing StoreIndex API but backed by SQLite.

Dependencies:
- `AppConfigService`, `Path`, `FileSystem`
- `StoreEventLog` (for rebuild if needed)
- `SqliteClient` / `SqlClient`

### Client management (per-store DB)

Implement a small client cache:

- `Ref<HashMap<StoreName, SqlClient>>`
- `Semaphore` or `Mutex` to prevent double-create.
- `getClient(store)`:
  - Compute DB path.
  - Ensure directory exists.
  - Create `SqliteClient.make({ filename })` inside the service scope.
  - Run migrations + `PRAGMA foreign_keys=ON`.
  - Cache client for reuse.

### Layer wiring

- `StoreIndexSqlite.layer` provides `StoreIndex`.
- `CliLive` chooses SQLite-backed layer instead of KV-backed StoreIndex.
- KeyValueStore remains for other services.

## Query Mapping to StoreIndex API

### apply (PostUpsert)

Use `SqlClient.withTransaction` to ensure atomicity:

1) Upsert into `posts` (on conflict update):

```sql
INSERT INTO posts (uri, created_at, created_date, author, post_json)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(uri) DO UPDATE SET
  created_at = excluded.created_at,
  created_date = excluded.created_date,
  author = excluded.author,
  post_json = excluded.post_json;
```

2) Replace hashtags:
- `DELETE FROM post_hashtag WHERE uri = ?`
- `INSERT INTO post_hashtag (uri, tag) VALUES (?, ?), ...`

### apply (PostDelete)

```sql
DELETE FROM posts WHERE uri = ?;
```

Cascade removes hashtags.

### getByDate

```sql
SELECT uri FROM posts WHERE created_date = ? ORDER BY created_at ASC;
```

### getByHashtag

```sql
SELECT uri FROM post_hashtag WHERE tag = ? ORDER BY uri ASC;
```

### getPost / hasUri

```sql
SELECT post_json FROM posts WHERE uri = ?;
SELECT 1 FROM posts WHERE uri = ? LIMIT 1;
```

Decode `post_json` with:
- `Schema.decodeUnknown(Schema.parseJson(Post))`

### query (range + limit)

If `range` present:

```sql
SELECT post_json FROM posts
WHERE created_at >= ? AND created_at <= ?
ORDER BY created_at ASC
LIMIT ?;
```

If no range, select all (with optional limit). Decode JSON for each row.

### entries (PostIndexEntry stream)

Prefer paged queries to avoid large memory spikes.

Query shape:

```sql
SELECT
  p.uri,
  p.created_date,
  p.author,
  group_concat(h.tag) AS hashtags
FROM posts p
LEFT JOIN post_hashtag h ON p.uri = h.uri
GROUP BY p.uri
ORDER BY p.created_at ASC
LIMIT ? OFFSET ?;
```

Transform:
- `hashtags` string -> `hashtags.split(",")` (empty if null).

### count

```sql
SELECT COUNT(*) AS count FROM posts;
```

### checkpoints

`loadCheckpoint`:
```sql
SELECT * FROM index_checkpoints WHERE index_name = ?;
```

`saveCheckpoint`:
```sql
INSERT INTO index_checkpoints (...) VALUES (...)
ON CONFLICT(index_name) DO UPDATE SET ...;
```

### clear

```sql
DELETE FROM post_hashtag;
DELETE FROM posts;
DELETE FROM index_checkpoints;
```

Optionally delete the DB file if store is deleted.

## Schema and SQL Utilities (Effect)

Use `SqlSchema` for typed query boundaries:

- `SqlSchema.findAll` for list queries (e.g., getByDate, getByHashtag).
- `SqlSchema.findOne` for getPost (nullable).
- `SqlSchema.void` for inserts/deletes.
- `SqlSchema.single` for `count` (returns a single row).

Define row schemas for decoding:

- `PostRow` -> `{ uri, created_at, created_date, author, post_json }`
- `PostIndexEntryRow` -> `{ uri, created_date, author, hashtags }`
- `CheckpointRow` -> `{ index_name, version, last_event_id, event_count, updated_at }`

## Migration and Bootstrapping Strategy

On first open of a store DB:

1) Run migrations.
2) If `posts` table empty AND event log has entries, run `StoreIndex.rebuild(store)`
   - This rebuilds from event log to populate SQLite.
3) Keep KV index around for now (no removal) but stop writing to it.

## Testing Plan

- Use `:memory:` for SQLite in tests where possible.
- Integration tests:
  - Apply upsert + delete.
  - Hashtag queries, date queries, range queries.
  - Checkpoints read/write.
  - `entries` pagination.
- Property tests (later): ensure SQL results match KV semantics on random post sets.

## Follow-up Work

- Update `StoreStats` size calculation to include SQLite file if stored outside KV root.
- Decide whether to migrate existing KV index data or rely on `rebuild`.
- Add config switch if we want to support both KV and SQLite backends.


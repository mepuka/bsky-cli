# SQLite Optimization Research — Query Performance

**Date:** 2026-01-29
**Context:** Query performance is the primary bottleneck. A 26k post store with `contains` filter hangs for 2+ minutes.

---

## Key Findings

### 1. FTS5 is available and the right solution for text search

- **Bun 1.3.4 ships SQLite 3.51.2** with FTS5 enabled
- FTS5 provides sub-millisecond full-text search on millions of rows
- Supports boolean operators (`AND`, `OR`, `NOT`), phrase search, prefix matching
- External content tables reference the main `posts` table — no data duplication
- Triggers keep the FTS index in sync automatically

### 2. Generated columns solve JSON extraction performance

- `ALTER TABLE posts ADD COLUMN text_content TEXT GENERATED ALWAYS AS (json_extract(post_json, '$.text')) VIRTUAL`
- Virtual columns are computed on read but **can be indexed** — the index is persisted
- You must query using the column name, not the json_extract expression
- Expression indexes are an alternative but require exact expression matching in queries

### 3. Current schema already has denormalized `author` column

The `posts` table has `author TEXT` as a real column, plus `post_hashtag(tag, uri)` join table. But queries don't use these — everything goes through JS-level filtering after fetching all rows.

### 4. Cursor-based pagination is strictly better than OFFSET

- Current: `LIMIT ? OFFSET ?` — OFFSET skips rows by scanning, O(offset) cost
- Better: `WHERE (created_at, uri) > (?, ?)` — keyset cursor, O(1) seek
- Always include a unique tiebreaker column (uri) for deterministic ordering

### 5. Index ordering: equality before range

- For `WHERE author = ? AND created_at BETWEEN ? AND ?`, best index is `(author, created_at)`
- SQLite "stops at the first range" in composite indexes
- The existing `created_at` index works for range scans, but a `(author, created_at)` composite would make author+date queries fast

### 6. DESC scanning works on ASC indexes

- SQLite can scan B-trees in either direction, so `ORDER BY created_at DESC` works with the existing ASC index
- Explicit DESC indexes provide marginal improvement

### 7. PRAGMA optimize should run on connection close

- `PRAGMA optimize` auto-runs ANALYZE on tables where stats are stale
- Since SQLite 3.46.0, it limits scope to complete quickly even on large DBs
- For long-lived connections: run `PRAGMA optimize=0x10002` on open, `PRAGMA optimize` periodically

---

## Recommended Implementation Plan

### Phase 1: Immediate fixes (no schema changes)

1. **Fix `--limit` semantics** — move limit from StoreQuery to `Stream.take(limit)` after filter
2. **Add `ORDER BY DESC` support** — add `sort` param to StoreQuery, pass to SQL
3. **Push `author:` filter to SQL** — the `author` column already exists and is likely indexed
4. **Run PRAGMA optimize** on connection close

### Phase 2: FTS5 + generated columns (schema migration)

5. **Add FTS5 virtual table** with content-sync triggers:
```sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  text,
  tokenize='unicode61 remove_diacritics 2',
  content='posts',
  content_rowid='rowid'
);

CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text)
    VALUES (new.rowid, json_extract(new.post_json, '$.text'));
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text)
    VALUES ('delete', old.rowid, json_extract(old.post_json, '$.text'));
END;

CREATE TRIGGER posts_fts_update AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text)
    VALUES ('delete', old.rowid, json_extract(old.post_json, '$.text'));
  INSERT INTO posts_fts(rowid, text)
    VALUES (new.rowid, json_extract(new.post_json, '$.text'));
END;
```

6. **Add composite indexes**:
```sql
CREATE INDEX idx_posts_author_date ON posts(author, created_at);
CREATE INDEX idx_posts_author_date_desc ON posts(author, created_at DESC);
```

7. **Backfill FTS on existing stores**: `INSERT INTO posts_fts(posts_fts) VALUES('rebuild');`

### Phase 3: Filter-to-SQL compiler

8. **Build `compileToSql(expr: FilterExpr)`** returning SQL fragments + remainder:

| Filter | SQL pushdown |
|--------|-------------|
| `author:handle` | `WHERE author = ?` |
| `contains:"text"` | `JOIN posts_fts WHERE posts_fts MATCH ?` |
| `hashtag:#tag` | `JOIN post_hashtag WHERE tag = ?` |
| `engagement:minLikes=N` | `json_extract(post_json, '$.metrics.likeCount') >= ?` |
| `is:reply` | `json_extract(post_json, '$.reply') IS NOT NULL` |
| `is:original` | `json_extract(post_json, '$.reply') IS NULL` |
| `AND` / `OR` / `NOT` | SQL boolean logic |
| `regex:/pattern/` | FTS prefix match + JS fallback |

9. **Hybrid query in store-index.ts**: push what can be pushed, Stream.filterEffect for remainder

### Phase 4: Performance pragmas

10. **Add to connection setup**:
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;      -- 64MB
PRAGMA temp_store = memory;
PRAGMA mmap_size = 30000000000;  -- 30GB
```

---

## Performance Impact Estimates

| Change | Query: author filter | Query: text search | Query: no filter |
|--------|---------------------|-------------------|-----------------|
| Current (JS filter) | ~10s (26k scan) | ~120s (26k parse) | ~1s (no filter) |
| Push author to SQL | ~10ms (index seek) | ~120s (unchanged) | ~1s (unchanged) |
| FTS5 for text | ~10ms (index seek) | ~10ms (FTS match) | ~1s (unchanged) |
| Full SQL pushdown | ~5ms (composite) | ~5ms (FTS+index) | ~1s (unchanged) |

---

## Sources

- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [SQLite Generated Columns](https://www.sqlite.org/gencol.html)
- [SQLite Query Planning](https://sqlite.org/queryplanner.html)
- [High Performance SQLite — Composite Indexes](https://highperformancesqlite.com/watch/composite-indexes)
- [SQLite JSON Virtual Columns + Indexing](https://www.dbpro.app/blog/sqlite-json-virtual-columns-indexing)
- [Use The Index Luke — Range Conditions](https://use-the-index-luke.com/sql/where-clause/searching-for-ranges/)
- [SQLite Pragma Cheatsheet](https://cj.rs/blog/sqlite-pragma-cheatsheet-for-performance-and-consistency/)
- [Bun SQLite Documentation](https://bun.com/docs/runtime/sqlite)

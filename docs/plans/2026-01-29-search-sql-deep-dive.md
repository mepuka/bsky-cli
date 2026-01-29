# Search + SQL Deep Dive (2026-01-29)

Goal: evaluate open SQL/search-related issues with a deeper look at FTS5, query pushdown, and CLI surface area.

## Summary
- FTS5 search posts is *mostly implemented* (schema + StoreIndex search + CLI command), but **legacy stores lack backfill**, so search may return empty for pre‑migration data.
- Query pushdown already covers many filters; the next high‑impact improvement is **FTS pushdown for text/contains**.
- Several open issues appear already implemented (#42, #37, #44, #31) and likely need verification + closure.

Open issues in scope:
- #46 Push filter predicates to SQL WHERE clauses
- #45 Add FTS5 full-text search index for post content
- #44 Add search command for discovering handles and feeds
- #42 Add descending sort (--sort desc / --newest-first) for queries
- #37 Add --wait <duration> for store locks
- #31 Add search posts command for full-text post discovery

---

## FTS5 + Search Posts (deep dive)
### Current implementation (already in code)
**Schema + triggers**
- Migration `src/db/migrations/store-index/003_fts_and_derived.ts`:
  - Adds `text`, `lang`, and derived columns to `posts`.
  - Creates `posts_fts` FTS5 table with `content='posts'` and `content_rowid='rowid'`.
  - Adds triggers to keep FTS in sync on INSERT/UPDATE/DELETE.

**Ingestion**
- `src/services/store-index-sql.ts` writes `text` and derived flags into `posts` on every upsert.
- Triggers should keep FTS in sync for *new* inserts/updates.

**Search API**
- `StoreIndex.searchPosts` uses `posts_fts MATCH ?` joined to `posts`, sorts by bm25 for relevance or by `created_at` for newest/oldest.
  - `src/services/store-index.ts` (searchPosts).

**CLI surface**
- `skygent search posts --store <store>` is already implemented in `src/cli/search.ts` and wired into `src/cli/app.ts`.

### Critical gaps
1) **Backfill for legacy stores**
   - Migration adds columns with defaults; existing rows get empty `text`/flags. Triggers only fire for new inserts/updates.
   - Result: FTS searches on pre‑migration stores often return no results.

2) **Index rebuild vs. incremental updates**
   - `StoreIndex.rebuild` replays event log into the index but does **not** run when posts already exist.
   - No automatic versioned rebuild for new columns.

3) **FTS query ergonomics**
   - `MATCH` expects FTS query syntax; plain user input can lead to errors or surprising results.
   - No `--literal` or escaping helper; docs may not explain FTS syntax.

### Proposed remediation
**A. Backfill strategy (highest priority)**
- Add a new migration to rebuild `posts_fts` and derived columns for existing stores.
  - Option 1 (fast, SQL-only): `INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')`.
    - Limitation: will only index current `posts.text`, which is empty for pre‑migration rows.
  - Option 2 (robust): run a **full index rebuild** from event log so `posts.text` + flags are recomputed.
    - Add a versioned index checkpoint (e.g., `version: 2`) and rebuild when version is stale.
    - Or provide a CLI command like `skygent store reindex <store>` that clears posts + replays events.

**B. Improve CLI/Docs**
- Document `skygent search posts` and its FTS query syntax.
- Add `--literal` (or `--phrase`) to auto‑quote user input.
- Consider `--sort newest|oldest|relevance` help text in docs.

**C. Integrate with filter DSL / query**
- Map `contains:` (or a new `text:` filter) to FTS `MATCH` pushdown when safe.
- Add escaping helpers so plain strings become valid FTS queries.

---

## SQL filter pushdown (#46)
### Current pushdown coverage
Implemented in `src/services/store-index.ts`:
- Author / AuthorIn
- Hashtag / HashtagIn
- DateRange
- IsReply / IsQuote / IsRepost / IsOriginal
- HasLinks / HasMedia / HasImages / HasVideo
- Language
- Engagement thresholds
- Contains (SQL `instr` with ASCII-only casefold)

### Gaps & recommendations
- **Text search**: replace `Contains` pushdown with FTS `MATCH` (when input is simple), or add a separate `Fts` filter tag.
- **Regex**: no pushdown (likely keep in Effect runtime).
- **HasValidLinks / Trending**: no pushdown (requires external services).

---

## Other open issues: quick evaluation
### #42 Descending sort
- Already implemented in `src/cli/query.ts` via `--sort asc|desc` and `--newest-first`.
- Backed by SQL order in `src/services/store-index.ts` and tests in `tests/services/store-index.test.ts`.
- Likely ready to close after verifying CLI help/docs.

### #37 --wait for store locks
- Implemented in `src/cli/shared-options.ts` and used in sync/watch/derive.
- Locking + wait in `src/services/store-lock.ts` via `Effect.retry` with a schedule.
- Possible small cleanup: unify wait parsing in jetstream sync and add a hint in lock error messages.

### #44 Search handles/feeds
- Implemented in `src/cli/search.ts` (`search handles` / `search feeds`) with API calls in `BskyClient`.
- Wired in `src/cli/app.ts`.
- Likely ready to close after verifying docs/examples.

### #31 Search posts
- Implemented via `search posts` + `StoreIndex.searchPosts` (FTS5). See above for backfill gap.
- If backfill is addressed, this can be closed.

---

## Proposed next steps (search/sql)
1) Add FTS backfill or full reindex strategy for legacy stores.
2) Add doc/CLI improvements for FTS query syntax.
3) Add optional FTS pushdown for `contains` or new `text:` filter.
4) Verify #42/#37/#44/#31 in CLI docs and close if confirmed.

# Arsenal Match-Day UX Review

**Date:** 2026-01-29
**Phase covered:** Phase 1 (Setup) + Phase 2 (Ingest) + initial Phase 4 (Explore)

---

## Bugs

### BUG-1: `--limit` limits DB fetch, not output rows (Critical UX)

**Observed:** `--limit 15` with `--filter 'contains:"Arsenal"'` returns 0 results even though 844 Arsenal posts exist.

**Cause:** `--limit` is passed to `StoreQuery.make({ limit })` which constrains the SQL `LIMIT` clause. Since posts are ordered `created_at ASC`, the first N rows are the oldest posts (2014), which don't match the filter. The filter applies *after* DB fetch via `Stream.filterEffect`.

**Expected:** `--limit` should limit the number of *output* rows (after filtering), not the DB scan size. A user saying `--limit 15` means "give me 15 matching results."

**Fix options:**
1. Rename current behavior to `--scan-limit` or `--fetch-limit`
2. Change `--limit` to mean output limit — remove it from `StoreQuery`, apply it as `Stream.take(limit)` after the filter
3. Add both: `--limit` (output) and `--scan-limit` (DB)

**Impact:** High. Every filtered query with `--limit` silently returns incomplete or empty results.

### BUG-2: Filtered queries on large stores hang/timeout (Critical Perf)

**Observed:** `--filter 'contains:"Arsenal"' --format card` on a 26k post store hangs for 2+ minutes without producing output. Even with `--range` narrowing to a few hours, it still hangs.

**Cause:** The query collects *all* matching posts into memory (`Stream.runCollect`) before rendering. For `card`/`compact`/`thread` formats, the entire result set must be collected, rendered to Doc, then printed. With `contains` filter, every post requires JSON parsing + regex evaluation.

**Expected:** Output should stream incrementally, or at minimum the query should complete within seconds for <1k matching posts.

**Notes:** `compact` format without `--range` + with `author:` filter works fine (~seconds for 5k posts). The hang seems specific to `contains`/`regex` filters on large datasets, possibly due to the JSON deserialization cost per post.

### BUG-3: Jetstream `--filter` captures delete events as "postsAdded" (Medium)

**Observed:** `sync jetstream --filter 'contains:"Arsenal"' --limit 2000` reported `postsAdded: 76` but all 76 events were `PostDelete` type. No actual Arsenal posts were captured.

**Cause:** Jetstream delete events don't have post text, but they pass through the filter pipeline and get counted as `postsAdded`. The filter can't evaluate `contains` on a delete event (no text), so it may be defaulting to `true`.

**Expected:** Delete events should either be excluded from content filters or counted separately. `postsAdded` should only count actual post creates.

### BUG-4: `store stats` reports 0 posts when posts exist (Medium)

**Observed:** After `sync jetstream` added 76 events, `store stats` reported `posts: 0, authors: 0`. After `sync timeline` added 7,090 posts, a subsequent `store stats` showed `posts: 19703` (correct after bootstrap).

**Cause:** The posts table wasn't populated until the first `query` triggered the bootstrap/rebuild from event_log. `store stats` may read from the posts table directly without triggering bootstrap.

**Expected:** `store stats` should trigger bootstrap if needed, or stats should query event_log directly.

---

## UX Issues

### UX-1: No descending sort option

**Impact:** High. Posts are always `ORDER BY created_at ASC`. For a monitoring scenario, you always want the newest posts first. Having to use `--range` to get recent posts is cumbersome.

**Suggestion:** Add `--sort desc` or `--newest-first` flag. Default could remain ASC for reproducibility, but DESC is the expected behavior for "show me what's happening now."

### UX-2: `contains` filter is case-sensitive by default (despite docs)

**Observed:** `contains:"Arsenal"` only matches exact case. The filter DSL documentation suggests case-insensitive by default, but in practice it appears case-sensitive.

**Suggestion:** Verify and document clearly. Most users expect case-insensitive text search.

### UX-3: No feedback during long-running filtered queries

**Impact:** Medium. A query that takes 30+ seconds gives zero output until completion. No progress indicator, no streaming output.

**Suggestion:** For `compact` format, output could stream line-by-line instead of collecting all results first. For `card`/`thread`, show a spinner or progress count.

### UX-4: Author handle validation errors are cryptic

**Observed:** Invalid handles return a wall of JSON error with HTTP headers, status codes, and nested cause chains.

**Example:** `sync author gaborkeleti.bsky.social` → 400 InvalidRequest with full HTTP headers dumped.

**Suggestion:** Parse the error and show: `Error: Author "gaborkeleti.bsky.social" not found on Bluesky.`

### UX-5: No way to search for handles/feeds from the CLI

**Impact:** Medium. To sync Arsenal content, we had to guess handles (`arsenal.bsky.social`, `arseblog.com`, etc.). No `skygent search` command to discover accounts or feeds.

**Suggestion:** Add `skygent search <query>` wrapping `app.bsky.actor.searchActors` and `app.bsky.feed.searchPosts`.

### UX-6: `sync jetstream` without `--filter` captures random global posts

**Impact:** Low (expected behavior), but the interaction between jetstream and `--filter` is confusing. The filter applies to *parsed* posts, but jetstream delivers raw events including deletes that can't be filtered meaningfully.

**Suggestion:** Document that jetstream is best used unfiltered for bulk capture, then use `derive` or `query --filter` for filtering. Or add jetstream-level DID/collection filtering (which already exists via `--dids` and `--collections`).

### UX-7: No `--output` or `--no-pager` option for piping

**Impact:** Low. Large outputs to stdout interact poorly with piping (SIGPIPE kills the process).

---

## What Worked Well

- `config check` — clear, fast, actionable
- `store create` / `store list` — simple and reliable
- `sync author` — fast, good progress logging
- `sync timeline` — synced 7k posts reliably
- `store stats` — useful summary (after bootstrap)
- `compact` format — fast, readable, ANSI colors work well
- Filter DSL — expressive, `contains`, `regex`, `author`, `hashtag`, `engagement` all parse correctly
- Error codes — consistent exit codes for different error types

---

## Recommendations for Phase 2+ Testing

1. Fix BUG-1 (`--limit`) before continuing — it blocks most filtered query workflows
2. Add `--sort desc` — essential for monitoring use case
3. Consider streaming output for `compact` format to avoid collect-all-then-render
4. Test `derive` workflow (doesn't depend on `--limit` fix since it processes all events)
5. Test `view thread` with a known post URI from the store

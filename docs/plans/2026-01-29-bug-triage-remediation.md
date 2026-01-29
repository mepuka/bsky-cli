# Bug Triage + Remediation Plan (2026-01-29)

Goal: verify status of current `bug` issues, document evidence, and list remediation steps/tests to close each issue.

## Summary
- #41 (stats bootstrap) appears fixed; verify repro and close.
- #38 (--limit with filter) appears fixed; verify repro and close.
- #40 (Jetstream delete counting) partially fixed; remaining behavior differs from expected. Needs targeted change + tests.
- #39 (filtered query hangs) partially addressed; still performance risks for large stores. Needs follow-up work and/or scoped defaults.

## Issue #41 — store stats shows 0 before first query
**Status:** Likely fixed.

**Evidence**
- `StoreStats.stats` now calls `index.count(store)` before reading aggregate counts, which triggers `StoreIndex` bootstrap via `withClient` and `bootstrapStore`. See:
  - `src/services/store-stats.ts`
  - `src/services/store-index.ts`

**Verification**
1) Repro from the issue:
   - Sync a store, run `skygent store stats` before any query.
   - Expected: non-zero `posts`/`authors` now reported.
2) Negative case: store with no events should still report 0 posts.

**If it still reproduces**
- Ensure the caller is using `StoreStats.stats` (not direct DB access).
- Check for bootstrap errors in logs and ensure `event_log` has data.

**Close criteria**
- Repro no longer shows 0 counts prior to querying.

---

## Issue #38 — `--limit` constrains DB fetch, not output
**Status:** Likely fixed.

**Evidence**
- `--limit` is applied after filtering; DB scan limit is only derived from `--limit` when **no filter** is present. When a filter is present, `scanLimit` is `undefined` unless explicitly set via `--scan-limit`.
  - `src/cli/query.ts`
  - `src/services/store-index.ts`

**Verification**
1) Repro from issue:
   - `skygent query <store> --filter 'contains:"Arsenal"' --limit 15 --format json`
   - Expected: returns 15 matching posts.
2) Confirm `--scan-limit` still limits DB reads and can truncate results (advanced behavior).

**Close criteria**
- Filtered query with `--limit` returns expected count, not empty.

---

## Issue #40 — Jetstream delete events counted as postsAdded
**Status:** Partially fixed; remaining behavior differs from expected.

**Current behavior**
- Deletes are **not** counted as `postsAdded` (correct).
- Deletes are always stored and counted as `postsDeleted`, even when the filter excludes the post or the post was never stored.
  - `src/services/jetstream-sync.ts`

**Gap vs expected**
- The issue expects filtered runs to ignore delete events that are out of scope or refer to posts not in the store.

**Remediation (recommended)**
1) Gate delete handling by store membership:
   - Inject `StoreIndex` into `JetstreamSyncEngine` and, on `CommitDelete`, check `StoreIndex.hasUri(store, uri)`.
   - If false, treat as `Skip` (do not store delete, do not increment `postsDeleted`).
2) Optional: Adjust progress reporting to include deletes in `stored` (or add a separate `deleted` count in progress).

**Tests**
Add to `tests/services/jetstream-sync.test.ts`:
- Delete only (no prior upsert) -> `postsDeleted=0`, `postsSkipped=1`.
- Create then delete with filter `all()` -> `postsAdded=1`, `postsDeleted=1`.
- Create then delete with filter `none()` -> both skipped.

**Close criteria**
- Filtered syncs no longer report deletes for posts outside the filter/store scope.

---

## Issue #39 — filtered queries hang on large stores
**Status:** Partially addressed; still performance risks.

**What’s already improved**
- Streaming output for `compact` and `card` formats; progress reporting; some SQL pushdown.
- FTS available for `search` command.

**Remaining bottlenecks**
- Filters not pushed down (regex/language/etc.) trigger full scans + JSON decode of every row.
- `json`, `markdown`, `table`, `thread` still call `Stream.runCollect`, delaying output and using unbounded memory.
- `Contains` uses `instr()` and does not leverage FTS.
- No default `scanLimit` for filtered queries; full-store scans can run for minutes.

**Remediation (phased)**
**Short-term (safe, fast)**
1) Add a default `scanLimit` for filtered queries unless user sets `--scan-limit`.
2) Push down `Language` filter via `p.lang IN (...)` (indexed).
3) Strong warning (or require `--limit`) for non-streaming formats when `filter` is present.
4) Stream JSON output (emit `[ ... ]` progressively) to avoid full collect.

**Medium-term**
1) Two-phase fetch: scan minimal columns for predicate; fetch `post_json` only for matched posts.
2) Add a dedicated full-text filter operator backed by FTS (`posts_fts MATCH`) rather than `instr()`.
3) Batch predicate evaluation (like OutputManager) for IO-heavy filters.

**Verification**
- Run the original repro: large store + filter + range.
- Measure time-to-first-output and total runtime for each output format.

**Close criteria**
- Query with filters and common output formats produces output quickly (seconds) on 20k+ stores.

---

## Next Actions
1) Verify #41 and #38 with the reported repros and close if confirmed.
2) Implement #40 delete gating + tests.
3) Pick short-term items for #39 (scanLimit default + Language pushdown + streaming JSON) and schedule; keep issue open until performance is acceptable.

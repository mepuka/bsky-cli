# Phase 6-8 Notes — Threads, Filter Analysis, Export

**Date:** 2026-01-29

## Phase 6: Thread Deep-Dive

### Results

- **API thread view** — works perfectly. Both card and compact modes render proper tree structures with `├──`, `│`, `└──` connectors. Nested replies indent correctly.
- **Compact thread** — excellent. Single-line per post with tree structure. Good for scanning large threads.
- **JSON thread output** — works, outputs full post array (54KB for a 38-reply thread).
- **`--depth` flag** — works to limit reply depth from API.

### Bugs

#### BUG-P6-1: Store-based thread view fails silently (High)

`view thread <uri> --store arsenal-matchday --ansi` exits with code 1 and produces no output — no error message, no stderr. The thread post exists in the store (it was fetched via `query`), but the thread command can't render it.

**Expected:** Either render the thread from local store data, or show an error explaining why it can't (e.g., "Thread replies not available in store — use API mode").

**Impact:** High. The `--store` flag for thread viewing is non-functional. Users have no way to know why.

### UX Observations

#### UX-P6-1: Thread rendering is the best output in the tool

The tree rendering with ANSI colors, proper connector characters, and compact/card modes is excellent. This is the most polished output format. The nested reply structure is immediately readable.

#### UX-P6-2: No reply count shown on thread root in compact mode

In compact thread view, the root post shows `♥ 64 💬 38` which is good. But individual replies with sub-replies don't always show their reply count, making it hard to spot deep sub-threads worth expanding.

---

## Phase 7: Filter Analysis

### Results

- **`filter describe --ansi`** — works well for all filters tested. Styled output with breakdown, compatibility, cost assessment.
- **`filter test`** — works. Returns `ok: true/false` with the post URI and parsed filter AST. Tested with a non-matching post, correctly returned `false`.
- **`filter benchmark`** — works. 500 posts processed in 37ms (0.074ms/post). However, matched 0 posts because it samples from the start of the store (oldest posts, which are arseblog posts from 2023 that don't match `@arsenal-core` hashtag filter).

### Bugs

#### BUG-P7-1: `filter benchmark` samples from start of store (Low)

Benchmark processed 500 posts, matched 0. The sample is taken from the beginning (oldest posts), which may not represent the overall store content. A random sample or configurable offset would give more realistic results.

#### BUG-P7-2: `filter test` output is raw JSON AST (Low)

The filter test output dumps the full filter AST tree as JSON, which is useful for debugging but not for a user who just wants to know "does this post match?" A simpler output like `Match: YES` or `Match: NO (post doesn't contain "goal")` would be more useful for interactive use.

### UX Observations

#### UX-P7-1: No `filter explain` command

The scenario planned for `filter explain --filter '@arsenal-goals' --post-uri <uri>` to show reasoning (which conditions matched, which didn't). This doesn't appear to exist. Would be very valuable for debugging filters.

---

## Phase 8: Export & Materialize

### Results

- **`store materialize`** — runs but returns `{"store":"arsenal-matchday","filters":[]}`, suggesting it needs filter configuration to know what to materialize. Not clear what this command is supposed to do without configured outputs.
- **`store summary`** — works well. Returns total counts (5 stores, 23,892 total posts), with per-store breakdown showing status and source relationships.
- **`store stats`** on derived views — works correctly. Shows post counts, top authors, hashtags, date ranges, and `derived: true` status.

### Bugs

#### BUG-P8-1: `store stats` reports `sizeBytes: 0` for all stores (Low)

Both source and derived stores report `sizeBytes: 0`. The SQLite files definitely have non-zero size on disk. Either the stat calculation is broken or not implemented.

#### BUG-P8-2: `store materialize` does nothing without configuration (Low)

The command returns immediately with an empty filters array. There's no documentation or error message explaining what configuration is needed, or whether `materialize` is meant to be used differently.

### UX Observations

#### UX-P8-1: `store summary` is JSON-only

Like most outputs, `store summary` returns raw JSON. A formatted table or tree showing the store hierarchy with post counts would be more useful for CLI users:

```
Stores: 5 (1 source, 4 derived)  Total: 23,892 posts

arsenal-matchday        21,759 posts  source
├── arsenal-goals-view     291 posts  ready (1.3%)
├── arsenal-players-view   922 posts  ready (4.2%)
├── arsenal-var-view        66 posts  ready (0.3%)
└── arsenal-viral-view     854 posts  ready (3.9%)
```

#### UX-P8-2: `store stats` missing `syncStatus` on derived stores

Source stores show `syncStatus: "stale"`, but derived stores don't include it. Adding `syncStatus` (or `freshness` — how far behind the source) would help users know if they need to re-derive.

---

## Cross-Phase Summary

### Performance

All operations are fast on the 21k post store:

| Operation | Time |
|-----------|------|
| Filtered query (compact, limit 10) | <0.5s |
| Filtered query (card, limit 5) | <0.4s |
| Full store scan (contains, all matches) | ~1.3s |
| Derive (21k events → filtered view) | ~2s |
| Thread view from API (38 replies) | <1s |
| Filter benchmark (500 posts) | 37ms |
| Store tree rendering | <0.3s |

### Top Issues to Address

1. **BUG-P6-1**: Store-based thread view silent failure — high impact
2. **BUG-P3-1/P3-2**: Regex parser can't handle spaces or parentheses — medium, limits filter expressiveness
3. **BUG-P8-1**: sizeBytes always 0
4. **UX-P8-1**: More commands need human-friendly output modes (not just JSON)
5. **UX-P7-1**: Missing `filter explain` for debugging filter logic

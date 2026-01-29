# Phase 4-5 Notes — Exploration & Derived Views

**Date:** 2026-01-29

## Phase 4: Deep Exploration

### Results

- All saved filter references (`@filter-name`) resolve correctly in queries
- `--format compact`, `card`, `thread` all render
- `--ansi` produces ANSI escape codes in all Doc-based formats
- `--range` time slicing works for date ranges
- Performance: all queries <1s on 21k posts (major improvement from prior session's 2+ minute hangs)

### New Behavior: `--scan-limit` Warning

A new warning appears on filtered queries:

```
Warning: applying default --scan-limit 5000 for filtered query. Results may be incomplete; set --scan-limit to override.
```

This is a partial fix for BUG-1 (--limit semantics). The query now separates `--limit` (output rows) from `--scan-limit` (DB fetch size). The default scan limit of 5000 means only 5000 rows are checked for matches — enough for most queries but may miss results in the tail of a 21k store.

**Observation:** This is a good interim solution. The warning is helpful. However, for a user who wants "all matches," there's no obvious way to say "scan everything." Need to document `--scan-limit 0` or `--scan-limit unlimited`.

### Bugs

#### BUG-P4-1: `--range` without filter shows unrelated content

`--range 2026-01-28T00:00:00Z..2026-01-29T23:59:00Z` returns timeline posts (general Bluesky, not Arsenal-related). This is correct behavior (range applies to all posts in the store), but confusing when the store has mixed content from timeline sync. Not a bug — expected. But worth noting for UX: users may expect `--range` to implicitly filter for relevant content.

#### BUG-P4-2: `--format thread` shows flat list, not tree

The `thread` format renders posts identically to `card` format — no tree structure, no reply indentation. Without reply relationships in the query results, the thread renderer has nothing to connect. This is expected for arbitrary query results (no guaranteed parent-child relationships), but the format name "thread" implies tree structure.

**Suggestion:** Either rename to something like `detail` or add a note that `--format thread` only shows tree structure when posts have reply relationships (e.g., from `view thread` or when querying a thread store).

### UX Observations

#### UX-P4-1: No `--sort desc` or `--newest-first`

Posts are always sorted ASC (oldest first). For monitoring, you want newest first. The `--range` workaround helps but adds friction.

#### UX-P4-2: Compact format is excellent for scanning

Single-line format with author, date, truncated text, and engagement metrics. Fast to scan, good information density. The ANSI coloring helps distinguish metadata from content.

#### UX-P4-3: Card format is good for reading

Multi-line cards with full text reflow, embed descriptions, and metrics. Good for reading individual posts. The blank line separator between cards helps visual grouping.

---

## Phase 5: Derived Views

### Results

| Derived Store | Source Posts | Matched | Match Rate | Duration |
|---------------|-------------|---------|------------|----------|
| arsenal-goals-view | 21,759 | 291 | 1.3% | 2.1s |
| arsenal-players-view | 21,759 | 922 | 4.2% | 2.5s |
| arsenal-viral-view | 21,759 | 854 | 3.9% | 2.4s |
| arsenal-var-view | 21,759 | 66 | 0.30% | 1.9s |

- All derivations completed successfully in ~2s each
- Auto-created target stores
- `store tree --ansi` renders a beautiful DAG with filter descriptions, match rates, and status indicators
- All derived views show `READY` status
- Querying derived views is instant (small result sets)

### What Worked Well

- **`store tree --ansi`** — best CLI output in the tool. Shows the full derivation DAG with filter expressions, match percentages, sync status. Very informative at a glance.
- **Auto-create target stores** — no need to manually `store create` before deriving. Good UX.
- **EventTime mode** — processes all events in the source store, not just the current posts table state. Correct semantics.
- **Match rate in tree** — showing "291 (1.3% match)" gives immediate feedback on filter selectivity.

### UX Observations

#### UX-P5-1: Derive output is JSON-only

The derive result `{"source":..., "target":..., "result":{...}}` is machine-readable but not human-friendly. A summary line like `Derived 291 posts (1.3%) from arsenal-matchday → arsenal-goals-view in 2.1s` would be clearer.

#### UX-P5-2: No progress indicator during derive

For the 2s derivations this is fine, but on larger stores this could hang silently (same issue as BUG-2/UX-3 from the prior review).

#### UX-P5-3: Store tree filter descriptions are long

The filter expression in the tree edge label can be very long, wrapping awkwardly. Consider truncating to ~60 chars with `...` or offering `--verbose` for full expressions.

#### UX-P5-4: No `derive --dry-run`

No way to preview what a derivation would match without actually creating the target store. A `--dry-run` flag showing match count and sample posts would help.

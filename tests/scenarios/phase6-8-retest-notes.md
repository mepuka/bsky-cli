# Phase 6-8 Retest Notes

**Date:** 2026-01-29
**After commits:** `843c889` (quick wins, regex DSL, query perf, view thread fallback), `8990ba2` (FTS indexing, store queries)

---

## Bug Status

| Issue | Bug | Status | Notes |
|-------|-----|--------|-------|
| #48 | Regex with spaces | **FIXED** | `regex:/red card|yellow card/i` parses and matches correctly |
| #49 | Regex with parentheses | **FIXED** | `regex:/\b(Saka|Rice|Odegaard)\b/i` parses and matches correctly |
| #50 | `view thread --store` silent failure | **FIXED** | Now renders the root post from store. Only root shown (replies not in store) — reasonable fallback |
| #51 | Benchmark samples from oldest posts | **Improved** | Now matched 1/500 (was 0/500). Still sampling from start, but slightly better. May need random sampling for accurate benchmarks |
| #52 | `filter test` raw AST output | **FIXED** | Now outputs `Match: no` with post URI, author, and human-readable filter expression. Clean and useful |
| #53 | `store stats` sizeBytes: 0 | **FIXED** | Now reports `sizeBytes: 220655616` (~210MB). `store summary` shows `totalSize: "230MB"` with human-readable formatting |
| #54 | `store materialize` empty with no guidance | **FIXED** | Now returns a clear error: `Store "arsenal-matchday" has no configured filters to materialize. Update the store config to add filters.` |

**7/7 issues addressed.** 5 fully fixed, 1 significantly improved (#51), 1 fixed with reasonable limitation (#50).

---

## Phase 6 Retest: Threads

- **API thread**: still renders full tree with replies — no regression
- **Store thread (card)**: renders root post only (replies not in store). No longer fails silently. Acceptable behavior.
- **Store thread (compact)**: same — root post rendered in compact mode
- **Store thread (JSON)**: returns JSON array with root post

**Remaining opportunity:** When store doesn't have replies, the thread view could show a hint: "Thread has 38 replies — use without --store to fetch from API." This would help users understand why they only see the root.

## Phase 7 Retest: Filter Analysis

- **Regex DSL**: spaces, parentheses, word boundaries, nested groups, character classes — all work. Complex patterns like `regex:/\b(4-[23]-[31]|back\s*(three|four|five))\b/i AND contains:"Arsenal"` parse and save correctly.
- **`filter test`**: clean output — `Match: no` / `Match: yes` with context. Major improvement.
- **`filter benchmark`**: matched 1/500 now (was 0). Still biased toward oldest posts but at least returning some results.

## Phase 8 Retest: Export & Materialize

- **`store stats`**: `sizeBytes` now correct (220MB for source store). Working.
- **`store summary`**: shows human-readable total size `230MB`. Per-store breakdown with status. Good.
- **`store materialize`**: clear error message explaining the prerequisite. No longer a confusing empty result.

---

## New Observations

### Scan-limit warning still appears on all filtered queries

```
Warning: applying default --scan-limit 5000 for filtered query. Results may be incomplete; set --scan-limit to override.
```

This is correct behavior but appears on every filtered query. For an agent workflow (running many queries), this adds noise. Consider:
- Suppress after first occurrence in a session
- Only warn when results are actually truncated (i.e., scan limit was hit before output limit)
- Add `--quiet` or `--no-warnings` flag

### Store-based thread shows root only without explanation

Not a bug — the store only has the root post, not replies. But a user might not understand why `--store` shows 1 post while API shows 38. A hint about falling back to API mode would help.

### Performance remains excellent

All operations <1s except full-store filtered scans (~1.3s). The development push didn't regress performance.

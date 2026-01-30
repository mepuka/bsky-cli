# Unfiled Improvements — Grouped for Batch Work

> From full surface coverage + prior phase notes. All open issues already filed are excluded.

---

## Group A: Output Polish (quick wins, no logic changes)

### A1. `filter list` doesn't show expressions
**Source:** UX-P3-1
Currently outputs bare JSON array of names. Should show a table with name + expression, like `store tree` does.

### A2. `filter describe` grammar — "not that are replies"
**Source:** Phase 9 / #70 (closed but grammar still awkward)
`hasimages AND NOT isreply` → "Posts with images and not that are replies". Should be "Posts with images that are not replies".

### A3. `config check` raw JSON only
**Source:** Full surface Phase 1
No `--format` support. A human-friendly pass/fail summary would be better for interactive use.

### A4. Derive output is JSON-only
**Source:** UX-P5-1
`derive` result is `{"source":..., "target":..., "result":{...}}`. A summary line like `Derived 291 posts (1.3%) from source → target in 2.1s` would be clearer.

### A5. `store delete nonexistent --force` exits 0
**Source:** Full surface Phase 15
Returns `{"deleted":false}` with exit 0. Should exit non-zero when nothing was deleted.

### A6. Inconsistent error formats (plain text vs JSON)
**Source:** Full surface Phase 15
Missing `--store` → plain text "Expected to find option: '--store'". Missing filter → JSON error. Should be consistent.

---

## Group B: Warnings & Hints (small UX improvements)

### B1. Store thread shows root only — no hint to use API
**Source:** Phase 6-8 retest
When `view thread --store` only has the root post, output doesn't explain why or suggest removing `--store` to fetch from API.

### B2. Scan-limit warning phrasing
**Source:** Full surface Phase 6
"Results may be incomplete" is slightly alarming. Better: "Scanned 5000 of N posts. Use --scan-limit to scan more."

### B3. `--format thread` renders flat for non-thread queries
**Source:** BUG-P4-2
`query store --format thread` shows card-style flat list since arbitrary query results have no parent-child relationships. The format name is misleading — should either warn or rename.

### B4. No reply count on individual replies in compact thread
**Source:** UX-P6-2
In compact thread view, sub-replies don't always show their reply count, making it hard to spot deep sub-threads.

---

## Group C: Features (more involved)

### C1. No `derive --dry-run`
**Source:** UX-P5-4
No way to preview derivation match count without creating the target store. A `--dry-run` flag showing count + sample would help iterate on filters.

### C2. No progress indicator during derive
**Source:** UX-P5-2
2s derivations are fine, but larger stores could hang silently. A progress counter or spinner would help.

### C3. Store tree filter descriptions too long
**Source:** UX-P5-3
Filter expressions in tree edge labels can wrap awkwardly. Consider truncating to ~80 chars with `...` or `--verbose` for full expressions.

### C4. Derived stores missing `syncStatus` in stats
**Source:** UX-P8-2
Source stores show `syncStatus: "stale"` but derived stores don't. Adding staleness info would help users know when to re-derive.

### C5. `contains` case sensitivity unclear
**Source:** UX-2
`contains:"Arsenal"` behavior (case-sensitive or not) is undocumented and may surprise users.

---

## Suggested Batch Order

**Quick wins (Group A — 30min total):** A1, A2, A4, A5, A6, A3
**Small UX (Group B — 30min total):** B1, B2, B3, B4
**Features (Group C — individual scope):** C1, C4, C3, C2, C5

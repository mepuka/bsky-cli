# Pre-Release Code Review Findings

> 4-agent parallel review completed 2026-01-30. Covers CLI commands, services/domain, filter DSL/query, and output formatting.

---

## Critical / High Priority

### 1. Regex global flag state mutation (filter-runtime.ts:642-647)
Compiled regex objects with `g`/`y` flags share mutable `lastIndex` state. `evaluateBatch` uses `concurrency: "unbounded"`, so concurrent evaluations can corrupt `lastIndex` mid-test.
**Fix:** Clone regex per evaluation or avoid global flag.

### 2. FTS5 query injection (store-index.ts:1029)
User search input passed directly to `MATCH ${query}` without sanitizing FTS5 operators (`OR`, `AND`, `NEAR()`, `"`, `*`). Malicious input causes syntax errors; data exposure unlikely but untested.
**Fix:** Quote-wrap user input or validate FTS5 syntax before use.

### 3. Named filter recursion — no cycle detection (filter-dsl.ts:843)
`@a → @b → @a` causes infinite loop. No depth limit on `resolveNamedFilter`.
**Fix:** Add visited-set or depth counter (cap ~50).

### 4. `Schema.decodeUnknownSync` in critical paths (store-manager.ts:267,292,308,320)
Throws instead of returning Effect. Invalid store names cause unhandled exceptions rather than typed errors.
**Fix:** Replace with `Schema.decodeUnknown` piped through Effect.

### 5. Post renderers don't null-check `post.text` (doc/post.ts:69,91,120)
Image-only posts with empty text crash compact/card renderers.
**Fix:** Default to `""` when text is null/undefined.

---

## Medium Priority

### CLI Layer
6. **Format option sets differ across commands** — 7+ distinct choice arrays. `query` has 7 formats, `search`/`graph`/`feed`/`post` have 3, `filter` has 2-3 per subcommand.
7. **`--filter` naming confusion** — means DSL filter in most commands but API feed-type filter in `sync author`.
8. **Duplicate `parseLimit` validation** — 6 copies across sync.ts, graph.ts, feed.ts, post.ts, query.ts, search.ts. Should be in shared-options.ts.
9. **Duplicate `parseBoundedIntOption`** — identical in sync.ts and watch.ts.
10. **`view-thread` missing depth/parentHeight validation** — sync.ts and watch.ts validate 0-1000 but view-thread.ts doesn't.
11. **Only `query` respects global `--output-format` config** — all other commands ignore it.
12. **Duplicate format option in search.ts** — lines 35-38 and 101-104 define the same thing.

### Service/Domain Layer
13. **Silent DB optimization failure** (store-db.ts:149) — `PRAGMA optimize` errors swallowed via `catchAll`.
14. **Bare `throw` in ULID generation** (store-writer.ts:14) — escapes Effect runtime on invalid time.

### Filter/Query
15. **Unicode case-insensitive search falls back to no SQL pushdown** (store-index.ts:401) — non-ASCII `contains` queries scan in-memory, performance cliff.
16. **Parser has no depth limit** for nested expressions — stack overflow on `((((…))))` with 1000+ levels.
17. **scanLimit exhaustion is silent** — returns empty results without indicating truncation.

### Output Formatting
18. **ANSI `--ansi` flag only on 4 of 12+ commands** — search, post, feed, graph have no ANSI support.
19. **`normalizeWhitespace` too aggressive** (format.ts:6) — `\s+` → `" "` destroys intentional line breaks in posts.
20. **Emoji width counting uses `.length`** (table.ts:25, format.ts:36) — multi-codepoint emoji misalign table columns.
21. **Markdown pipe escaping incomplete** (format.ts:16) — only `|` escaped; `**bold**`, `[links]`, etc. render as markdown.
22. **Inconsistent table headers** — some UPPER CASE (search.ts), some Title Case (format.ts, store-tree.ts).
23. **Long words break `wrapText`** (doc/post.ts:44-46) — words exceeding `maxWidth` overflow without hyphenation.

---

## Low Priority

24. Terminology inconsistency: "progress logs" vs "progress output" in help text.
25. Missing `--quiet` on query and derive commands.
26. Missing short aliases (`-q` for `--quiet`, `-n` for `--limit`).
27. Width options accept 0 or negative values without validation.
28. Thread orphan posts shown as roots with no indicator.
29. No RTL text handling.
30. `ensureNewline` doesn't normalize multiple trailing newlines.
31. No "empty result set" feedback in card/compact formats.
32. Identity cache TTL 24h — stale handles after rename.
33. No circuit breaker for persistent Bluesky API failures.

---

## Overall Assessment

**Service/domain layer: 8.5/10** — Excellent Effect patterns, strong error handling, proper resource management. No data integrity or security issues.

**CLI layer: 7/10** — Good command structure via `@effect/cli`, but format options, validation, and shared utilities have accumulated inconsistencies.

**Filter/query: 8/10** — Sophisticated DSL with SQL pushdown optimization. The regex race and FTS5 injection are the key items to address.

**Output formatting: 6.5/10** — Functional but inconsistent across commands. The Doc-based rendering system is well-designed; the issues are mostly in edge cases and legacy formatters.

**Top 5 items for pre-release:**
1. Fix regex race condition (#1)
2. Sanitize FTS5 input (#2)
3. Add filter recursion guard (#3)
4. Null-check post.text (#5)
5. Replace `decodeUnknownSync` (#4)

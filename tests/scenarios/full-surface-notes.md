# Full CLI Surface Coverage — Live Test Notes

> Testing started 2026-01-29

---

## Phase 1 — Config & Health

**Status: PASS**

- `config check` exits 0, returns JSON with all 3 checks OK (store-root, credentials, bluesky).
- No bugs found.

**UX note:** Output is raw JSON. A human-friendly summary (like a table or colored pass/fail) would be nicer for interactive use. The `--output-format` or `--format` flag doesn't apply here.

---

## Phase 2 — Store Lifecycle

**Status: PASS**

All commands work: `create`, `list`, `show`, `stats`, `summary`, `tree` (all formats + `--ansi` + `--width`), `delete --force`.

**Findings:**

1. **UX:** `store delete` without `--force` exits with error "--force is required to delete a store" instead of showing an interactive confirmation prompt. Clear but CLI-unfriendly — an interactive confirm would be better UX.

2. **UX:** `store stats` on an empty store returns `hashtags:[]` and `topAuthors:[]` — could be omitted when empty to reduce noise.

3. **UX:** `store tree` output is excellent across all formats. No issues.

---

## Phase 3 — Sync: All 7 Sources

**Status: PASS (6/7 sources)**

| Source | Posts Added | Notes |
|--------|------------|-------|
| timeline | 9593 | OK |
| feed (whats-hot) | 393 | OK, 437 skipped (deduped) |
| list | 0 | List URI may have been empty/invalid, but no error |
| notifications | 0 | OK (no post-type notifications) |
| author (bsky.app) | 845 | OK |
| thread | 62 | OK (using valid URI from store) |
| jetstream | 48 | OK (5s / 50 limit) |

**Findings:**

1. **BUG:** `sync thread` with an invalid/deleted post URI produces a verbose error: `"An unknown error occurred in Effect.tryPromise (status 400, Post not found: ...)"`. The error message should be cleaner — e.g. "Post not found: <uri>".

2. **UX:** `sync list` with a graph list URI returned 0 posts without error. Unclear if the list was empty or if it's not a valid list-feed URI. A warning or info message would help.

---

## Phase 4 — Sync Flags

**Status: PASS**

| Flag | Result |
|------|--------|
| `--quiet` | OK — suppressed progress, only start/complete logs |
| `--refresh` | OK — re-fetched posts, warned about event log growth |
| `--wait "10 seconds"` | OK — 0 added, skipped all (freshness window) |
| `--filter "hasimages"` | OK — filtered during sync (8 added out of full timeline) |
| `--post-filter "hasimages"` | OK — 165 added from author bsky.app with images |

**Findings:** None — all flags work as expected.

---

## Phase 5 — Watch Mode

**Status: NOT TESTED (requires interactive SIGINT)**

Watch mode was skipped as it requires manual Ctrl-C testing. Both `watch timeline` and `watch jetstream` start correctly based on Phase 3 sync behavior.

---

## Phase 6 — Query: All Formats & Flags

**Status: PASS**

All 7 output formats work: `json`, `ndjson`, `markdown`, `table`, `compact`, `card`, `thread`.
All format modifiers work: `--ansi`, `--width 60`.
All sort options work: `--sort desc`, `--newest-first`.
All field presets work: `@minimal`, `@social`, `@full`.
Range filtering works: `--range "2025-01-01..2026-02-01"`.
Query filtering works: `--filter "hasimages"`.
`--scan-limit 10` works and limits row scan.

**Findings:**

1. **UX:** `--fields "author.handle,text"` only returned `text` — the nested dot-path `author.handle` was silently ignored. Should either work or produce a warning.

2. **UX:** `--progress` flag on query produced no visible progress output — same output as without it. May only be relevant for large filtered queries.

3. **UX:** Filtered queries without explicit `--scan-limit` emit: `Warning: applying default --scan-limit 5000 for filtered query. Results may be incomplete; set --scan-limit to override.` Good warning, but slightly alarming. Consider saying "scan limit" instead of framing as "incomplete".

---

## Phase 7 — Filter CRUD

**Status: PASS**

All CRUD operations work: `create`, `list`, `show`, `validate`, `validate-all`, `delete`.

**Findings:** None — clean CRUD flow.

---

## Phase 8 — Filter DSL Exhaustive

**Status: PASS (14/15 predicates)**

| Predicate | Valid? |
|-----------|--------|
| `hasimages` | YES |
| `hasvideo` | YES |
| `haslinks` | YES |
| `hasembed` | **NO** — "Expected a filter expression like 'hashtag:#ai' or 'author:handle'" |
| `hasmedia` | YES |
| `isreply` | YES |
| `isquote` | YES |
| `contains:hello` | YES |
| `regex:/^hello/i` | YES |
| `lang:en` | YES |
| `hashtag:#test` | YES |
| `author:bsky.app` | YES |
| `engagement:minLikes=10` | YES |
| Boolean: `AND`, `OR`, `NOT`, `()` | YES |

**Findings:**

1. **BUG:** `hasembed` is not a valid predicate despite `hasimages`, `hasvideo`, `haslinks`, `hasmedia` all being valid. There's no predicate for "has any embed" which is a gap.

2. **UX (major):** The DSL uses concatenated keywords (`hasimages`, `isreply`) rather than the more intuitive colon syntax (`has:images`, `is:reply`). The error message suggests `hashtag:#ai` or `author:handle` but doesn't list all valid predicates. A `filter help` subcommand or `--help` that lists all predicates would be very valuable.

3. **UX:** `text:contains "hello"` and `text:matches "^hello"` are not valid — the correct forms are `contains:hello` and `regex:/^hello/i`. The colon is part of the keyword, not a type:value separator. This is non-obvious.

4. **UX:** `label:nsfw` and `from:bsky.app` are not valid — correct forms are unknown (no label predicate) and `author:bsky.app`. The `from:` alias is a natural expectation from other search UIs.

---

## Phase 9 — Filter Analysis

**Status: PASS**

All analysis commands work with correct DSL:
- `filter describe` produces excellent human-readable output with breakdown, mode compatibility, effectfulness, cost, and complexity. ANSI and JSON output both work.
- `filter test` correctly identifies matching posts.
- `filter explain` provides per-predicate match detail (e.g., `hasImages=true`).
- `filter benchmark` reports processing stats (1000 posts in 147ms, 12.1% match rate for `hasimages`).

**Findings:**

1. **UX (minor):** `filter describe` text says "Posts with images and not that are replies" — the grammar is awkward. Should be "Posts with images that are not replies".

---

## Phase 10 — Derivation

**Status: PASS**

| Operation | Result |
|-----------|--------|
| EventTime derive | OK — 1147/9604 matched |
| DeriveTime derive | OK — same counts |
| Staleness check (fresh) | `"status":"ready"` |
| Add data + staleness check | `"status":"stale"` |
| Incremental re-derive | OK — only processed 47 new events |
| Reset derive | OK — reprocessed all 9651 events |
| `view status` | Works correctly |
| `view thread --compact` | Beautiful ASCII tree rendering |
| `view thread --format json` | OK |

**Findings:**

1. **BUG:** `view thread` with default text format (no `--compact`, no `--format`) hangs indefinitely with no output. Must use `--compact` or `--format json`. Killed after 15+ seconds with no output.

2. **UX:** Derivation auto-creates target stores — good behavior, logged as info message.

---

## Phase 11 — Search

**Status: PASS**

All search commands work:
- `search handles` (JSON, table, typeahead)
- `search feeds` (JSON, table)
- `search posts --network` (all sort options, `--lang`, `--author`)
- `search posts --store` (local FTS with relevance/newest sort)

**Findings:** None — search is solid.

---

## Phase 12 — Graph

**Status: PASS**

All graph commands work:
- `graph followers` / `graph follows` (JSON, table)
- `graph known-followers` (mutual followers)
- `graph relationships --others` (follow status between actors)
- `graph lists` / `graph lists --purpose curatelist`
- `graph blocks` / `graph mutes` (empty arrays — expected)

**Findings:** None — graph commands are clean.

---

## Phase 13 — Feed Discovery

**Status: PASS**

All feed commands work:
- `feed show` (JSON, table)
- `feed batch` (multiple URIs at once)
- `feed by` (feeds by actor)

**Findings:** None.

---

## Phase 14 — Post Engagement

**Status: PASS**

All engagement commands work:
- `post likes` (JSON, table with cursor)
- `post reposted-by` (JSON with cursor)
- `post quotes` (JSON with full quote-post data)

**Findings:** None.

---

## Phase 15 — Error & Edge Cases

**Status: PASS**

| Scenario | Result |
|----------|--------|
| Query nonexistent store | Exit 3, "Store does not exist" + suggestion |
| Show nonexistent store | Exit 3, same |
| Delete nonexistent store --force | Exit 0, `{"deleted":false}` |
| Invalid filter DSL | Exit 2, clear error with caret position |
| Invalid feed URI | Exit 5, SyncError with API error |
| Invalid thread URI | Exit 5, SyncError with API error |
| Missing --store | Exit 2, "Expected to find option: '--store'" |
| Missing derive args | Exit 2, "Missing argument <source>" |
| Missing filter test args | Exit 2, "Provide --filter or --filter-json" |
| `--output-format json` | OK — overrides format |
| `--log-format json` | OK — already default |
| `--compact` (global) | OK — reduces to minimal fields |

**Findings:**

1. **UX:** `store delete nonexistent --force` exits 0 with `{"deleted":false}` — arguably should exit non-zero since the operation didn't accomplish anything. The `--force` flag implies intent to delete.

2. **UX:** Error messages for invalid URIs are very verbose — full Effect.tryPromise stack with HTTP headers. Should show a clean "Invalid AT-URI" or "Post not found" message.

3. **UX:** Missing required args produces inconsistent error formats — some are plain text ("Expected to find option: '--store'") and some are JSON. Should be consistent.

---

## Summary of Issues Found

### Bugs
1. **`view thread` default format hangs** — no output, must use `--compact` or `--format json`
2. **`hasembed` predicate missing** — gap in DSL predicate coverage

### UX Improvements
1. **Filter DSL discoverability** — no help text listing valid predicates; `has:images` / `from:` / `label:` are natural guesses that fail
2. **`filter describe` grammar** — "not that are replies" should be "that are not replies"
3. **Error verbosity** — SyncError for invalid URIs shows full HTTP headers and Effect stack
4. **Inconsistent error format** — some plain text, some JSON
5. **`--fields` dot-path silently ignored** — `author.handle` doesn't work or warn
6. **`store delete nonexistent --force` exits 0** — should exit non-zero
7. **`config check` output is raw JSON** — no human-friendly mode
8. **`store delete` has no interactive confirm** — only --force
9. **Scan-limit warning phrasing** — "may be incomplete" is slightly alarming

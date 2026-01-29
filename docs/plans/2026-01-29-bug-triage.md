# Bug Triage + Remediation Plan (2026-01-29)

Goal: capture current `bug` issues, summarize evidence, and outline Effect-native remediation + tests.

## Summary
- Quick wins queued: #53 (stats size), #51 (benchmark order), #52 (filter test output), #54 (materialize empty guidance).
- Parser correctness: #48/#49 require regex-aware tokenization or parser-side scan.
- Performance/UX: #39/#47 need batch predicate evaluation and optional progress flag.
- Error clarity: #43 needs structured `BskyError` and CLI actor validation.
- View thread UX: #50 should fall back to API and populate the store when local data is missing.

## Decisions (from this triage)
- Progress output should be behind a flag (e.g. `--progress`) to minimize noise.
- `view thread --store` should fall back to API if the post is missing and then populate the store.

---

## Issue #53 — store stats always reports sizeBytes: 0
**Status:** Ready to fix (quick win).

**Evidence**
- `StoreStats.storeSize` points at `storeRoot/kv/<store.root>`; store data (index sqlite + outputs) lives under `storeRoot/<store.root>`.
  - `src/services/store-stats.ts:168`
  - `src/services/store-db.ts:29-37`

**Remediation (proposed)**
1) Update `storeSize` path to `path.join(config.storeRoot, store.root)`.
2) Keep `directorySize` fallback to 0 for missing dirs.

**Verification**
- Create a store, sync posts, run `skygent store stats`. Expect `sizeBytes > 0` and `totalSize` non-zero.

**Close criteria**
- `sizeBytes` reflects actual store data for populated stores.

---

## Issue #54 — store materialize returns empty result with no guidance
**Status:** Ready to fix (quick win).

**Evidence**
- `store materialize` emits `{ filters: [] }` when config has no filters; no user guidance.
  - `src/cli/store.ts:247`
  - `src/domain/defaults.ts:3`

**Remediation (proposed)**
1) Detect empty filter config and return `CliInputError` with guidance:
   - “No filters configured. Use `skygent store update --config-json …` or create filters in config.”
2) Optional: add `--force` to allow no-op materialize for automation.

**Verification**
- Run `skygent store materialize <store>` with empty config; expect clear error and fix suggestion.

**Close criteria**
- Users get actionable guidance instead of silent empty output.

---

## Issue #52 — filter test output is raw JSON AST
**Status:** Ready to fix (quick win).

**Evidence**
- `filter test` always emits `filter: expr` (raw AST) in JSON output.
  - `src/cli/filter.ts:234-255`

**Remediation (proposed)**
1) Add `--format text|json` (default `text`).
2) Text output: “Match: yes/no”, plus filter string (use `formatFilterExpr(expr)`), and post summary.
3) JSON output: keep existing `filter` AST; optionally add `filterText` for convenience.

**Verification**
- `skygent filter test ...` default shows human-readable output.
- `skygent filter test --format json` preserves AST.

**Close criteria**
- Default output is readable without losing JSON mode.

---

## Issue #51 — filter benchmark samples oldest posts
**Status:** Ready to fix (quick win).

**Evidence**
- Benchmark uses `StoreQuery.make({ scanLimit })` with default `order=asc`, so it scans oldest posts first.
  - `src/cli/filter.ts:304`
  - `src/services/store-index.ts:616`

**Remediation (proposed)**
1) Set `order: "desc"` for benchmark queries (sample newest by default).
2) Optional: add `--sort asc|desc` to allow explicit control.

**Verification**
- Compare sample to recent post timestamps; newest-first is used by default.

**Close criteria**
- Benchmarks reflect recent posts unless configured otherwise.

---

## Issue #50 — view thread --store exits silently with no output
**Status:** Needs fix.

**Evidence**
- Store path ignores `uri` and loads entire store, so missing posts lead to empty/irrelevant output.
  - `src/cli/view-thread.ts:72-95`
- Rendering assumes `post.reply.parent.uri` exists; missing parent can throw a defect and suppress stderr logging.
  - `src/cli/doc/thread.ts:16-22`
  - `index.ts:113-125`

**Remediation (proposed)**
1) Validate `uri` via `StoreIndex.hasUri` or `StoreIndex.getPost`.
2) If missing and `--store` set, **fall back to API**:
   - Fetch thread via `BskyClient.getPostThread`.
   - Populate store (write posts + index) before rendering.
3) Render a thread subset when using store data (ancestors + descendants of the target uri).
4) Guard against `reply.parent` being absent in thread rendering.

**Verification**
- `skygent view thread <uri> --store <store>`:
  - If missing, fetches API thread and persists to store.
  - If present, renders only the target thread (not entire store).

**Close criteria**
- No silent exits, and threads render consistently for store and API paths.

---

## Issue #49 — regex parentheses parsed as DSL grouping
## Issue #48 — regex patterns with spaces break parser
**Status:** Needs fix.

**Evidence**
- Tokenizer splits words on whitespace and parentheses unless inside quotes, revealing regex literals as multiple tokens.
  - `src/cli/filter-dsl.ts:72-140`
- Regex parsing expects a single token for `/.../flags`.
  - `src/cli/filter-dsl.ts:528`
  - `src/cli/filter-dsl.ts:907`

**Remediation (proposed)**
1) Make `/.../flags` a single token when `key === "regex"` (tokenizer regex mode or parser-side scan).
2) Avoid treating commas inside `/.../` as option separators.
3) Add tests:
   - `regex:/red card|yellow card/i`
   - `regex:/\\b(Saka|Rice)\\b/i`
   - `regex:/a{1,3}/`

**Close criteria**
- Regex literals with spaces/parentheses work unquoted.

---

## Issue #47 — no progress feedback during long-running filtered queries
## Issue #39 — filtered queries hang on large stores
**Status:** Needs fix (performance + UX).

**Evidence**
- Filtered queries evaluate predicates per post (`Stream.filterEffect`), which is slow for effectful filters.
  - `src/cli/query.ts:210-248`
- Some output formats collect all posts in memory, delaying output.
  - `src/cli/query.ts:268-314`

**Remediation (proposed)**
1) Add `--progress` flag (default off) to control progress output.
2) Switch to batch predicate evaluation for filters (`evaluateBatch` + `Stream.grouped`).
3) Update progress reporting to operate per batch (reduce overhead).
4) Consider two-phase fetch (minimal columns → fetch JSON for matches) as a follow-up for large stores.

**Close criteria**
- Filtered queries return results promptly without excessive CPU/memory.

---

## Issue #43 — cryptic error messages for invalid handles / API failures
**Status:** Needs fix.

**Evidence**
- CLI accepts raw `actor` input; invalid handles error only at API layer.
  - `src/cli/shared-options.ts:69`
- `BskyError` is a simple message/cause, so CLI can’t format specific actionable failures.
  - `src/domain/errors.ts:14`
  - `src/services/bsky-client.ts:115`

**Remediation (proposed)**
1) Add `ActorRef` schema (handle or DID) for CLI inputs; fail early with `CliInputError` and fix suggestions.
2) Make `BskyError` a tagged union with structured fields (`operation`, `status`, `error`, `detail`) for better CLI messaging.

**Close criteria**
- Invalid handles get clear, actionable CLI errors; API failures identify status/operation.

---

## Next Actions
1) Implement quick wins: #53, #54, #52, #51.
2) After quick wins, prioritize #48/#49 (parser correctness) and #39/#47 (batch filtering + optional progress).
3) Schedule #50 and #43 once parser/perf are stabilized.

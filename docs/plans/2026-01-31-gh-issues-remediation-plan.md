# GitHub Issues Remediation Plan (2026-01-31)

Goal: group the current open issues, identify shared root causes, and define an Effect-native refactor plan that eliminates the classes of bugs (format routing, error handling, and input validation).

Status: none of the open issues are ready to close yet; all require code changes and tests.

## Open issues (grouped)

**Group A — Output formats + compact/full behavior**
- #119 query command broken for all non-JSON output formats (P0)
- #120 --compact help text identical to --full (P2)
- #126 markdown output format silently falls back to JSON for graph/feed/post (P2)
- #127 --compact and --full produce identical output for graph/feed/post (P3)

**Group B — Pipe/NDJSON compatibility**
- #121 pipe command incompatible with query ndjson output (P1)

**Group C — Input validation + sync limits**
- #122 sync/feed/post commands don't validate URI format (P2)
- #128 sync commands lack --limit flag (P3)

**Group D — Store operation semantics**
- #124 store delete on nonexistent store gives misleading error (P2)
- #125 store rename reports moved:false on success (P2)

**Group E — Auth error handling**
- #123 inconsistent auth error handling in graph commands (P3)

## Root cause synthesis

1) **Output resolution and rendering are duplicated per command**  
   `query` has custom format resolution, while graph/feed/post use `emitWithFormat` with a narrow format list. This leads to inconsistent behavior for `compact/full`, markdown, and non-JSON formats. Rendering is split between `domain/format.ts` and `cli/doc` tables.

2) **Input schemas are not centralized**  
   At-URIs are only branded strings without validation. CLI args accept free text, so invalid inputs fail late (HTTP errors).

3) **Command output schemas are mismatched**  
   `pipe` expects `RawPost` but `query --format ndjson` emits `Post` or `{ store, post }`. NDJSON empty output behavior is inconsistent (`[]` vs no output).

4) **Store operation results lack semantic detail**  
   `delete` and `rename` return coarse booleans that collapse distinct states (missing vs failed).

5) **Auth errors are not normalized**  
   Some graph endpoints preflight auth, others allow requests to fail with 401/403; CLI surfaces inconsistent messages.

## Effect-native refactor opportunities

Grounded in Effect sources (`@effect/cli` HelpDoc + ValidationError) and effect-solutions guidance (cli, error-handling, services-and-layers, data-modeling).

### A) OutputFormat ADT + centralized resolution
- Introduce `OutputFormat` ADT (json, ndjson, table, markdown, compact, card, thread, text).
- Add `resolveCliOutputFormat({ formatFlag, configFormat, compactPref, defaultFormat })`.
- Remove `query`-specific format fallback logic; route all commands through the resolver.

### B) Single output dispatcher
- Expand `emitWithFormat` to handle all formats (including markdown).
- Add `emitJsonArrayStream` helper to stream JSON arrays without buffering.
- Define a single NDJSON empty-output rule (either output nothing or a sentinel; apply everywhere).

### C) Unified renderers
- Consolidate table/markdown rendering into one surface (prefer CLI `doc` renderers or move `domain/format.ts` to CLI).
- Remove dual implementations (`renderTableLegacy` vs domain format).

### D) Structured errors + CLI renderer
- Define domain errors as `Schema.TaggedError` (e.g., `AuthRequiredError`, `StoreMissingError`, `InvalidUriError`).
- Provide a CLI error-mapping helper that converts domain errors to `HelpDoc` (consistent output).
- Optional: introduce a `CliRenderer` service (Context.Tag) to render stdout/stderr consistently at the entrypoint.

### E) Schema-driven args and input parsing
- Define `AtUri` with a regex pattern in `src/domain/primitives.ts`.
- Use `Args.withSchema(AtUri)` in shared CLI options.
- For `pipe`, introduce a `PipeInput` schema: union of `RawPost` and `Post` (and `{ store, post }` if needed). Map to a single internal shape.

## Phased implementation plan

### Phase 0 — Foundations (shared abstractions)
**Outcome:** reduce duplication and enable consistent fixes.
- Add `OutputFormat` ADT + `resolveCliOutputFormat`.
- Expand `emitWithFormat` for markdown + unified NDJSON behavior.
- Introduce `PipeInput` schema (RawPost | Post | { store, post }) and a normalizer.
- Add `AtUri` schema with pattern validation.
- Draft `mapCliErrors` helper for domain-to-CLI error mapping.

### Phase 1 — P0/P1 fixes (core UX blockers)
**Issues:** #119, #121
- #119: track whether `--fields` is user-provided vs implicit compact defaults; only reject explicit fields for non-JSON formats.
  - Proposed: change `resolveFieldSelectors` to return `{ fields, source: "implicit" | "explicit" }`.
  - Update validation in `query` to only reject when source = explicit.
- #121: accept `Post` NDJSON in `pipe`, normalize to internal raw representation.
  - Optional: add `--input-format raw|post|auto` but default to auto-detect.
  - Align NDJSON empty output rule across `query` and `pipe`.

### Phase 2 — P2 fixes (correctness + clarity)
**Issues:** #122, #124, #125, #126, #120
- #122: apply `Args.withSchema(AtUri)` for feed/post/list URIs.
- #124: return structured delete result (`{ deleted, reason }`), map `reason: "missing"` to a clear message and zero exit code.
- #125: clarify `moved` semantics. Either:
  - Change to `movedOnDisk` and keep current meaning, or
  - Compute `moved` from the actual move attempt rather than `fromExists`.
- #126: either add markdown rendering for graph/feed/post or reject with a validation error listing supported formats.
- #120: split `--full` and `--compact` into distinct options with separate help descriptions and exclusivity handling.

### Phase 3 — P3 fixes (consistency)
**Issues:** #123, #127, #128
- #123: use `ensureAuth(true)` for graph endpoints that require auth (blocks/mutes/follows/followers/lists), or map 401/403 to `AuthRequiredError`.
- #127: integrate `CliPreferences.compact` with graph/feed/post JSON output so compact/full differs, or explicitly scope compact/full to commands that support it.
- #128: add `--limit` to non-jetstream sync subcommands and propagate into sync options.

## Verification + close criteria (per issue)

- #119: `skygent query <store> --format table` works without `--fields`, and still rejects explicit `--fields`.
- #121: `query --format ndjson | pipe` succeeds with both `RawPost` and `Post` inputs.
- #122: invalid `at://` input yields immediate CLI validation error before API call.
- #124: deleting a nonexistent store prints “store not found” (or equivalent) with success exit code.
- #125: rename output reflects disk move semantics explicitly and matches actual behavior.
- #126: `--format markdown` either renders markdown or errors with supported formats.
- #120: help text for `--compact` and `--full` are distinct and accurate.
- #123: graph commands consistently fail fast with auth hints when credentials are missing.
- #127: compact vs full differs for graph/feed/post JSON (or flags are scoped).
- #128: all sync subcommands accept `--limit` and stop after that many posts.

## Notes / decisions needed

1) **Markdown behavior (#126):** implement markdown tables for graph/feed/post vs reject w/ validation error.  
2) **NDJSON empty output rule:** output nothing (true NDJSON) vs `[]` sentinel.  
3) **Store rename semantics (#125):** keep `moved` as disk move indicator or switch to “rename succeeded”.


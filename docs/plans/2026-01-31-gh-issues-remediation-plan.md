# GitHub Issues Remediation Plan (2026-01-31)

Goal: group the current open issues, identify shared root causes, and define an Effect-native refactor plan that eliminates the classes of bugs (format routing, error handling, and input validation).

Status: Phase 0–3 implemented; issues #119–#128 are ready to close pending PR/merge. Open enhancement remains (#96).

## Open issues

- #96 Add skygent digest command (enhancement)

## Resolved in Phase 0–3 (ready to close)

- #119 query command broken for all non-JSON output formats
- #120 --compact help text identical to --full
- #121 pipe command incompatible with query ndjson output
- #122 sync/feed/post commands don't validate URI format
- #123 inconsistent auth error handling in graph commands
- #124 store delete on nonexistent store gives misleading error
- #125 store rename reports moved:false on success
- #126 markdown output format silently falls back to JSON for graph/feed/post
- #127 --compact and --full produce identical output for graph/feed/post
- #128 sync commands lack --limit flag

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

## Phased implementation plan (original scope)

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

## Phase 4 — Effect-native hardening (post-merge refactors)

Goal: reduce code duplication, strengthen input validation, and align errors with Effect-native patterns.

1) **Schema-driven CLI options**
   - Use `Options.withSchema` for numeric options (`limit`, `batch-size`, `max-errors`, `width`, `depth`, `parent-height`).
   - Consider `Schema.Duration` (or equivalent) for any time window inputs (e.g. `--since`).
   - Replace ad-hoc `Schema.decodeUnknown` in CLI handlers with `Args.withSchema` / `Options.withSchema` (e.g., `view-thread`).

2) **ParseError normalization**
   - Map `ParseResult.ParseError` to a consistent CLI error (exit code 2).
   - Reuse `formatSchemaError` to avoid leaking raw parse details.
   - Consolidate parse formatters (`formatSchemaError`, `formatFilterParseError`, `formatStoreConfigParseError`) into one shared helper.

3) **Equivalence/Order consolidation**
   - Define `Equivalence`/`Order` for key domain types (e.g., StoreId, AtUri, RecordKey) and reuse for sorting/dedup.
   - Replace ad-hoc comparators across CLI and services with the shared instances.

4) **Graph utility surface (Effect Graph module)**
   - Evaluate Effect Graph module for representing follow/list relationships.
   - Prototype a lightweight graph builder that accepts `getFollows/getFollowers` streams.

5) **Multi-store query cleanup**
   - Normalize multi-store query inputs into a single algebraic shape.
   - Centralize query planner logic (filters, pagination, ordering) and reuse in CLI/query/pipe.

## Phase 5 — Enhancement #96 (skygent digest)

Goal: add a CLI command that summarizes a store for a time window.

- Command surface: `skygent digest <store> --since 24h [--format json|markdown|table]`
- Data points: top posts by engagement, trending hashtags, new authors, post volume.
- Implementation: derive from query + aggregation pipeline; prefer Effect Stream + Schema decoders.

## Phase 6 — Auth + graph UX enhancements (AT Protocol deep dive)

1) **Session refresh + 2FA**
   - Support `com.atproto.server.refreshSession` using stored refresh tokens.
   - Add `--auth-factor` / `SKYGENT_AUTH_FACTOR_TOKEN` handling for `AuthFactorTokenRequired`.

2) **Public vs authed clarity**
   - Surface a hint when using the public API host and explain missing viewer fields in graph output.

3) **Graph/list command coverage**
   - Add list-level mutes/blocks commands: `graph list-mutes`, `graph list-blocks`.
   - Add `graph lists-with-membership <actor>` for membership discovery.
   - Consider `graph follow/unfollow` commands (record create/delete).
   - Optional: list CRUD (`graph list-create`, `graph list-add`, `graph list-remove`, `graph list-delete`).

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
6) **Streaming safety**
   - Avoid unbounded `Stream.runCollect` on large stores; prefer `Stream.runForEach` or apply a default `--limit`.
   - If new async streams are introduced, set explicit `bufferSize`/`strategy` to avoid unbounded buffers.

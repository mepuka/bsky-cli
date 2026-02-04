# CLI UX + Agentic Improvements: Multi-Phase Engineering Plan (Issues #173-198)

Date: 2026-02-04
Owner: skygent-bsky

## Goals
- Resolve all open UX/agentic issues (#173-198) with a phased, low-risk rollout.
- Improve automation safety and observability without breaking existing scripts.
- Keep changes Effect-native and aligned with current CLI/service conventions.

## Non-goals
- Full redesign of CLI command structure.
- Major breaking changes to default output formats or config schema.
- Heavy data migrations beyond current store/catalog/index patterns.

## Current Status (2026-02-04)
- Phase 0: Complete (implemented, closed).
- Phase 1: Complete (implemented, closed).
- Phase 2: Complete (implemented, closed).
- Phase 3: Complete (implemented, closed).
- Phase 4: Deferred.

## Issue Inventory

| ID | Title | Category | Proposed Phase | Status |
|----|-------|----------|----------------|--------|
| #198 | Dry Run Mode: Preview operations before executing | Agent safety | Phase 2 | Closed |
| #197 | Credential encryption key requires env var in every session | Credentials | Phase 4 | Planned |
| #196 | Structured Error Output: Machine-readable error codes | Agent safety | Phase 2 | Closed |
| #195 | Idempotent operations with explicit success semantics | Agent safety | Phase 2 | Closed |
| #194 | Sync Progress/ETA: Enhanced feedback during sync operations | UX + observability | Phase 2 | Closed |
| #193 | Add actor resolve command for DID/handle resolution | CLI ergonomics | Phase 1 | Closed |
| #192 | Add auto-labeling for detected communities | Analysis UX | Phase 3 | Closed |
| #191 | Output Format Consistency + global format config | CLI ergonomics | Phase 1 | Closed |
| #190 | Capabilities introspection command for agent discovery | Agent UX | Phase 1 | Closed |
| #189 | Inline --filter-help for predicate discovery | CLI ergonomics | Phase 1 | Closed |
| #188 | Bulk source addition (multi-author input) | CLI ergonomics | Phase 1 | Closed |
| #187 | Command syntax inconsistency: positional store vs --store | CLI ergonomics | Phase 1 | Closed |
| #186 | Add description field to stores | Store metadata | Phase 3 | Closed |
| #185 | Graph analysis summary stats | Analysis UX | Phase 3 | Closed |
| #183 | Sync fails when API returns -1 for quoteCount | Bug fix | Phase 0 | Closed |
| #182 | Sync help text wrong (positional vs --store) | Bug fix | Phase 0 | Closed |
| #181 | Add search users alias for search handles | Bug fix | Phase 0 | Closed |
| #177 | Link content filtering predicate | Analysis UX | Phase 3 | Closed |
| #174 | Improve errors for global flag positioning | CLI ergonomics | Phase 1 | Closed |
| #173 | Add --description to store create | Store metadata | Phase 3 | Closed |

## Phase 0: Correctness + Immediate UX Fixes (fast, low risk)

### Scope
- #183: Coerce -1 metric values to undefined before PostMetrics schema.
- #182: Fix sync help example for --store.
- #181: Add `search users` alias for `search handles`.

### Implementation Notes
- `src/services/bsky-client.ts`: add `coerceMetricCount` and use in metrics mapping.
- `src/cli/sync.ts`: update help examples.
- `src/cli/search.ts`: extract handler, add alias command.

### Tests
- Update or add tests in `tests/services/bsky-client.test.ts` using fixtures with `-1`.
- Add a small CLI test for alias help or command dispatch (if coverage exists).

### Exit Criteria
- Sync no longer fails on -1 metrics.
- Help text and alias available.

## Phase 1: CLI Ergonomics + Discovery

### Scope
- #187: Support both positional and `--store` for all relevant commands (no breaking change).
- #174: Improve error message when global flags placed after store name (or allow both positions).
- #189: `--filter-help` inline option for predicate quick reference.
- #191: Standardize output format resolution + optional env var `SKYGENT_OUTPUT_FORMAT`.
- #190: `skygent capabilities` command for machine-readable discovery.
- #193: `skygent actor resolve` CLI binding for `IdentityResolver`.
- #188: Bulk author input for `store add-source`.

### Design Notes
- Add a shared store resolver helper in `src/cli/shared-options.ts` that accepts positional + option, detects conflicts, and returns a consistent `StoreName`.
- Centralize output format resolution in `src/cli/output-format.ts` and use `resolveOutputFormat` everywhere.
- `capabilities` should be derived from source-of-truth arrays: `filterSuggestions`, format arrays, command lists, and source types.

### Key Files
- `src/cli/shared-options.ts`: store resolver + `filterHelpOption`.
- `src/cli/query.ts`, `src/cli/sync.ts`, `src/cli/watch.ts`, `src/cli/graph.ts`, `src/cli/search.ts`, `src/cli/filter.ts`, `src/cli/view-thread.ts`, `src/cli/digest.ts`.
- `src/cli/output-format.ts`: env var support in resolution.
- `src/cli/capabilities.ts` (new) + `src/cli/app.ts` wiring.
- `src/cli/actor.ts` (new) + `src/cli/app.ts` wiring.
- `src/cli/store.ts`: bulk add-source inputs.

### Tests
- Add CLI tests for `--store`/positional resolution and conflict errors.
- Add tests for `--filter-help` output (json + human).
- Add tests for `capabilities` and `actor resolve`.
- Add tests for output format resolution priority (flag > env > config > fallback).

### Exit Criteria
- CLI accepts both store syntaxes where applicable.
- `capabilities` and `actor resolve` commands functional.
- Inline filter help works.

## Phase 2: Agent Safety + Observability

### Scope
- #196: Structured error output with stable codes and consistent JSON envelope.
- #195: Idempotent operations with explicit `action` in response.
- #198: Dry-run support for mutation commands.
- #194: Enhanced sync progress (source context + ETA where possible).

### Status (2026-02-04)
- Completed and validated with full test suite and typecheck.
- Error envelope gated by `SKYGENT_JSON_ERRORS`.
- Dry-run avoids writes across sync/derive/store mutations.

### Design Notes
- Introduce a `CliErrorEnvelope` schema and unify error reporting in `index.ts`.
- Update mutation responses to include `action: created|updated|unchanged|deleted`.
- Add dry-run switches for `sync`, `derive`, and store mutation commands where safe.
- Extend `SyncProgress` and logging to include `store`, `source`, and `deleted` fields.

### Key Files
- `src/cli/errors.ts` + new `src/cli/error-codes.ts` (if codes are implemented).
- `index.ts`: error handling output + JSON mode.
- `src/services/store-manager.ts`, `src/services/store-sources.ts`, `src/services/filter-library.ts`.
- `src/cli/store.ts`, `src/cli/filter.ts`, `src/cli/derive.ts`.
- `src/domain/sync.ts`, `src/services/sync-engine.ts`, `src/cli/logging.ts`.
- `src/services/jetstream-sync.ts`, `src/services/derivation-engine.ts`, `src/cli/sync-factory.ts`, `src/cli/sync.ts`.

### Tests
- CLI integration tests: verify structured error JSON on stderr.
- Service tests for idempotent action outputs.
- Dry-run tests for derive and store mutations (no writes, correct preview counts).
- Sync progress tests for source/store context.

### Validation (completed)
- `bun test` (338 pass).
- `bun run typecheck` (pass).

### Exit Criteria
- Agents can rely on structured error outputs and action semantics.
- Dry-run available for destructive or large operations.
- Sync progress is machine-parseable and informative.

## Phase 3: Data + Analysis UX

### Scope
- #173 + #186: Store descriptions (DB migration + CLI support).
- #185: Graph summary stats output.
- #192: Community auto-labeling.
- #177: Link content filter predicate.

### Design Notes
- Add `description` column to store catalog + schema optional field.
- Extend graph snapshot output to include stats and labels; keep existing fields for compatibility.
- Link-content predicate should use existing embed metadata + post links (no network fetch).

### Key Files
- `src/db/migrations/store-catalog/002_add_description.ts` + migration index.
- `src/domain/store.ts`, `src/services/store-manager.ts`, `src/cli/store.ts`.
- `src/domain/graph.ts`, `src/services/graph-builder.ts`, `src/graph/communities.ts`, `src/cli/graph.ts`.
- `src/domain/filter.ts`, `src/cli/filter-dsl.ts`, `src/services/filter-runtime.ts`.

### Tests
- Store description: create/update/list/show tests.
- Graph stats + community labels: unit tests on known snapshots.
- Link-content predicate: DSL parse + runtime matching tests.

### Status (2026-02-04)
- Completed: store description migration + CLI create/update/show/list support.
- Completed: graph summary stats embedded in interactions/centrality/communities outputs (JSON/NDJSON/table).
- Completed: community auto-labeling (central member handle) in graph communities output.
- Completed: link-content predicate via `links:/pattern/` and `link-contains:...`.
- Issues closed: #173, #177, #185, #186, #192.

### Validation (completed)
- `bun test` (340 pass).
- `bun run typecheck` (pass).

### Exit Criteria
- Store metadata includes descriptions without breaking existing rows.
- Graph output includes summaries and readable labels.
- Link-content predicate usable via DSL.

## Phase 4: Credentials Persistence

### Scope
- #197: Persist credential key across sessions.

### Recommended Approach
- Phase 4.1: Keyfile support (fast, cross-platform).
- Phase 4.2: Optional keychain backend (macOS/Windows/Linux) if desired later.

### Key Files
- `src/services/credential-store.ts`: key resolution chain.
- `src/cli/config-command.ts`: add `credentials key set` and `status`.
- `docs/credentials.md`: usage and setup.

### Tests
- CredentialStore key resolution order.
- Missing key when credentials file exists -> clear error.
- Keyfile permissions if supported.

### Exit Criteria
- New sessions can read credentials without env var.
- Backward compatibility preserved.

## Cross-Cutting Risks
- Output format changes can break scripts; keep defaults unchanged and add explicit opt-ins.
- Structured error JSON must not leak secrets.
- Idempotent semantics should not mask actual failures (IO, network).

## Resolved Decisions (Phase 3)
- Link-content filtering matches URLs only (post links + external embed URIs).
- Community labels are derived at output time (central member), not stored.
- Store descriptions are nullable; empty input clears to NULL.

## Suggested Next Step
- Begin Phase 4 credential key persistence work.

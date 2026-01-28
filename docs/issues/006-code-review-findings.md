# Code Review Findings - V1 Readiness

**Date:** 2026-01-28
**Scope:** Full codebase review across domain, services, CLI, tests, and configuration.

---

## P0 - Critical (must fix before V1)

### CR-01: `Date.now()` used instead of Effect `Clock` across services

Multiple services bypass Effect's `Clock` service, breaking testability and time control:

- `src/services/sync-engine.ts:271,322,375` — `Date.now()`
- `src/services/jetstream-sync.ts:223,452` — `Date.now()`
- `src/services/store-writer.ts:106` — `Date.now()` for ULID generation
- `src/services/store-manager.ts:136` — `new Date().toISOString()`
- `src/services/jetstream-sync.ts:142` — `new Date().toISOString()`
- `src/services/sync-engine.ts:122` — `new Date().toISOString()`

**Fix:** Replace all with `Clock.currentTimeMillis` (as `derivation-engine.ts` already does).

### CR-02: `DateRange` filter missing start < end validation

`src/domain/filter.ts:366-373` — A `DateRange` with `start > end` passes schema validation but silently matches nothing at runtime.

**Fix:** Add a schema refinement that validates `start < end`.

### CR-03: `Engagement` filter accepts all-undefined thresholds

`src/domain/filter.ts:317-322` — All three fields (`minLikes`, `minReposts`, `minReplies`) are optional with no refinement requiring at least one. Semantically equivalent to `All` but misleading.

**Fix:** Add schema refinement requiring at least one threshold.

### CR-04: Version mismatch between package.json and CLI

`package.json:3` says `0.1.0`, `index.ts:18` hardcodes `0.0.0`. CLI `--version` reports wrong version.

**Fix:** Read version from `package.json` or use a build-time constant.

### CR-05: StoreDb leaks SQLite clients on store deletion

`src/services/store-db.ts:40` — Cached SQLite clients in `Ref<Map<string, SqlClient>>` are never removed when a store is deleted via `StoreCleaner`. File handles and memory leak until process exit.

**Fix:** Add a `removeClient(storeName)` method to `StoreDb` and call it from `StoreCleaner.deleteStore`.

### CR-06: SyncEngine cursor never advances across pages

`src/services/sync-engine.ts:253-254` — The cursor is captured once from the initial checkpoint and never updated as pages are consumed. Subsequent runs may re-process pages.

**Fix:** Bubble up the pagination cursor from the Bluesky API stream into checkpoint saves.

### CR-07: `extractFromFacets` uses `unknown` type-punning

`src/domain/extract.ts:28-63` — Discards type safety by accepting `ReadonlyArray<unknown>` and manually checking properties. Ignores `$type` discriminator, risking double-counting features.

**Fix:** Accept `ReadonlyArray<RichTextFacet>` and use the `$type` discriminator.

---

## P1 - Important (should fix for V1)

### CR-08: `Handle` regex rejects uppercase handles

`src/domain/primitives.ts:4` — Pattern `/^[a-z0-9][a-z0-9.-]{1,63}$/` rejects `Alice.bsky.social`. Bluesky handles are case-insensitive.

**Fix:** Either add case-insensitive flag or normalize to lowercase before validation.

### CR-09: `StoreQuery.limit` allows floats and negatives

`src/domain/events.ts:37` — Uses `Schema.Number` instead of `Schema.NonNegativeInt`.

**Fix:** Change to `Schema.NonNegativeInt`.

### CR-10: Missing barrel exports from `domain/index.ts`

`src/domain/index.ts` does not re-export: `config.ts`, `format.ts`, `indexes.ts`, `filter-describe.ts`, `filter-explain.ts`, `derivation.ts`.

**Fix:** Add missing exports (check for circular dependency issues first).

### CR-11: StoreIndex.query loads entire result set into memory

`src/services/store-index.ts:345-386` — Returns `Stream` but fetches all rows at once internally. Defeats streaming for large stores.

**Fix:** Use `paginateChunkEffect` with `LIMIT/OFFSET` (same pattern as `entries` method).

### CR-12: StoreIndex rebuild wraps each event in its own transaction

`src/services/store-index.ts:183-232` — Thousands of individual transactions during rebuild. Major performance issue.

**Fix:** Batch events into larger transactions (e.g., 100-500 at a time).

### CR-13: Duplicated helpers across services

The following helpers are copy-pasted 2-3 times each:

| Helper | Locations |
|--------|-----------|
| `messageFromCause` | bsky-client, sync-engine, jetstream-sync |
| `pickDefined` | app-config, sync-settings, derivation-settings |
| `formatSchemaError` | app-config, credential-store, filter-library, cli/filter.ts, cli/filter-dsl.ts |
| `directorySize` | resource-monitor, store-stats |
| `validatePositive`/`validateNonNegative` | sync-settings, derivation-settings |
| `safeParseJson`/`hasPath`/`issueDetails` | cli/filter-errors, cli/store-errors |

**Fix:** Extract into `src/services/shared.ts` and `src/cli/shared.ts`.

### CR-14: Duplicated CLI option definitions

`filterOption`, `filterJsonOption`, `storeNameOption`, `quietOption`, `strictOption`, `maxErrorsOption`, `parseMaxErrors`, `parseFilter` are redeclared 3-5 times across sync, watch, filter, query, derive.

**Fix:** Create `src/cli/shared-options.ts` with all shared option definitions.

### CR-15: Sync/watch command boilerplate duplication

`timelineCommand`, `feedCommand`, `notificationsCommand` have nearly identical bodies in both `sync.ts` and `watch.ts` (~300 lines duplicated).

**Fix:** Create a shared command factory accepting a `DataSource` constructor.

### CR-16: Missing `--limit` validation in query command

`src/cli/query.ts:37-39` — No positive integer validation, unlike the sync command's `parseLimit`.

**Fix:** Add validation matching the sync command pattern.

### CR-17: `config check` command missing from CLI docs

`src/cli/config-command.ts` implements the command but `docs/cli.md` does not document it.

**Fix:** Add `config check` section to `docs/cli.md`.

### CR-18: `SKYGENT_SYNC_*` env vars undocumented

`.env.example` lists `SKYGENT_SYNC_CONCURRENCY`, `SKYGENT_SYNC_CHECKPOINT_EVERY`, `SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS` but `docs/configuration.md` does not mention them.

**Fix:** Add sync settings section to configuration docs.

### CR-19: TrendingTopics creates its own AtpAgent

`src/services/trending-topics.ts:53` — Creates a separate `AtpAgent` from `BskyClient`, resulting in duplicate sessions and rate limiting.

**Fix:** Have `TrendingTopics` depend on `BskyClient` instead.

---

## P2 - Test Coverage Gaps

### CR-20: Missing tests for security-critical credential-store

`src/services/credential-store.ts` — PBKDF2/AES-GCM encryption with zero tests. Need encrypt/decrypt round-trip, error paths, resolution priority tests.

### CR-21: Missing tests for store-lock concurrent access

`src/services/store-lock.ts` — Filesystem-based locking with no tests. Need concurrent lock, release, and error path tests.

### CR-22: Filter runtime lacks false-path tests

`tests/services/filter-runtime.test.ts` — Only tests matching (true) results. A filter returning `true` always would pass all tests.

**Fix:** Add rejection assertions for every filter variant.

### CR-23: Missing tests for store-commit deduplication

`src/services/store-commit.ts` — `appendUpsertIfMissing` dedup logic untested directly.

### CR-24: Missing tests for link-validator

`src/services/link-validator.ts` — Cache TTL, HEAD-to-GET fallback, non-HTTP URL handling all untested.

### CR-25: Missing tests for settings validation

`src/services/sync-settings.ts` and `src/services/derivation-settings.ts` — Config boundary validation untested.

### CR-26: Duplicated test infrastructure

`makeTempDir`/`removeTempDir`/`buildTestLayer` copy-pasted across 5+ test files.

**Fix:** Extract into `tests/support/test-layer.ts`.

### CR-27: Test file placement inconsistency

`tests/derivation-engine.test.ts` and `tests/derivation-validator.test.ts` should be in `tests/services/`.

---

## P3 - Suggestions (nice to have)

### CR-28: `filterExprSignature` uses `JSON.stringify` without guaranteed key ordering

`src/domain/filter.ts:441` — Fragile for signature comparison. Consider canonical serialization.

### CR-29: `PostFromRaw` encode path does not round-trip `mentionDids`

`src/domain/raw.ts:108-139` — Schema transform is not a proper isomorphism.

### CR-30: Inconsistent store name: positional arg vs option

`query` uses positional arg, `sync`/`watch` use `--store` option. Justified but potentially confusing.

### CR-31: `renderStoreTree` and `renderStoreTreeAnsi` share ~150 lines of duplicated tree-walking logic

`src/cli/store-tree.ts:254-332` and `480-577`. Could use a visitor pattern.

### CR-32: No JSDoc on exported domain types or functions

Zero JSDoc comments across the entire domain layer. Core API surface like `FilterExpr`, `PostFromRaw`, `describeFilter` would benefit.

### CR-33: `extractLinks` regex captures trailing punctuation

`src/domain/extract.ts:3` — URL regex includes trailing `.`, `,`, etc.

### CR-34: Unused devDependencies

`vitest` and `@effect/vitest` in `package.json` with `bun test` workflow.

### CR-35: Changeset tooling on a private package

`@changesets/cli` and release scripts serve no purpose while `"private": true`.

### CR-36: `writeJson` pretty parameter never used

`src/cli/output.ts:73` — Accepts `pretty` but no command passes `true`. Disconnected from `CliPreferences.compact`.

### CR-37: `cli/format.ts` is a trivial single-line re-export

Only used by `query.ts`. Could import directly from `../domain/format.js`.

### CR-38: `configCheckCommand` lacks a description

`src/cli/config-command.ts:33` — Only command without `Command.withDescription`.

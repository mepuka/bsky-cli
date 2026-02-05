# Skygent Full-Stack Code Review

**Date:** 2026-02-05
**Scope:** Complete codebase review across CLI, Services, Domain, Graph, and Tests
**Methodology:** 5 parallel review agents (CLI layer, Services layer, Domain types, Test suite, Effect patterns audit)

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [Critical Issues](#critical-issues)
- [Important Issues](#important-issues)
- [Suggestions](#suggestions)
- [Test Coverage Gaps](#test-coverage-gaps)
- [Architecture Opportunities](#architecture-opportunities)
- [What Was Done Well](#what-was-done-well)

---

## Executive Summary

The Skygent codebase is well-engineered with strong Effect-TS conventions, consistent service patterns, thorough input validation, and a solid test suite (343 tests, 100% pass rate). The architecture is clean with strict module boundaries (domain -> services -> cli) properly maintained.

That said, the review uncovered **3 critical issues** (concurrency bugs, resource leaks, error masking), **16 important issues** across all layers, and numerous suggestions for improved robustness and performance. The most impactful architectural opportunity is migrating to `Effect.Service` to eliminate the 258-line manual layer wiring file.

---

## Critical Issues

### C1. Race Condition in StoreCommitter Lock Map

**File:** `src/services/store-commit.ts:128-142`

The `getLock` function uses a non-atomic read-modify-write on a `Ref<Map>`. Two concurrent fibers hitting the same previously-unseen store name simultaneously could each create their own semaphore, defeating the mutual exclusion guarantee that protects transactional writes.

```typescript
// Current: Non-atomic TOCTOU
const current = yield* Ref.get(locks);        // Fiber A reads: no lock
const existing = current.get(storeName);       // Fiber B reads: no lock
// Both create new semaphores, one overwrites the other
```

**Fix:** Use `SynchronizedRef.modifyEffect` for atomic check-and-create:
```typescript
const locks = yield* SynchronizedRef.make(new Map<string, Semaphore>());
const getLock = (storeName: string) =>
  SynchronizedRef.modifyEffect(locks, (current) => {
    const existing = current.get(storeName);
    if (existing) return Effect.succeed([existing, current] as const);
    return Effect.makeSemaphore(1).pipe(
      Effect.map((sem) => {
        const next = new Map(current);
        next.set(storeName, sem);
        return [sem, next] as const;
      })
    );
  });
```

**Note:** The similar pattern in `StoreDb.getClient` (lines 198-222) is correctly implemented using a semaphore-guarded double-check lock. Use that as the reference.

### C2. StoreDb Scope Leak on Client Open Failure

**File:** `src/services/store-db.ts:167-196`

`openClient` creates a manual `Scope.make()` for each SQLite client, but if any PRAGMA or migration step fails after the client is created, the scope is never closed. The client remains open indefinitely, leaking file descriptors and database connections.

```typescript
const clientScope = yield* Scope.make();
const client = yield* SqliteClient.make({ filename: dbPath }).pipe(
  Effect.provideService(Scope.Scope, clientScope), // scope created
);
yield* client`PRAGMA busy_timeout = 5000`;  // if this fails...
yield* migrate.pipe(...);                    // or this fails...
// clientScope is leaked -- never closed on error path
```

**Fix:** Add an `onError` handler or use `Effect.acquireRelease` to ensure scope cleanup:
```typescript
const program = Effect.gen(function* () {
  const clientScope = yield* Scope.make();
  // ... client creation and setup
  return { client, scope: clientScope };
}).pipe(
  Effect.tapError(() =>
    Scope.close(clientScope, Exit.fail(new Error("client init failed")))
  )
);
```

### C3. Schema.decodeUnknownSync in Error Factory Functions

**Files:**
- `src/services/lineage-store.ts:35`
- `src/services/view-checkpoint-store.ts:28`
- `src/services/store-renamer.ts:30`

These error factory functions use `Schema.decodeUnknownSync` to construct `StorePath` values. If the sync decode throws (e.g., unexpected characters in store name), the *original error* that triggered the factory is masked by the decode exception. This is particularly dangerous because it happens inside error mapping paths.

```typescript
// lineage-store.ts:35 -- called inside Effect.mapError
const toStoreIoError = (storeName: StoreName) => (cause: unknown) => {
  const path = Schema.decodeUnknownSync(StorePath)(`stores/${storeName}/lineage`);
  // ^^ If this throws, the original `cause` is lost
  return StoreIoError.make({ path, cause });
};
```

**Fix:** Pre-compute the path outside the error handler, or use the Effect-based `Schema.decodeUnknown` within the error mapping chain.

---

## Important Issues

### I1. Unbounded Concurrency in Multiple Locations

**Files:**
- `src/cli/store.ts:887-891` -- `{ concurrency: "unbounded" }` for actor resolution
- `src/cli/derive.ts:120` -- same
- `src/cli/actor.ts:119` -- same
- `src/services/images/image-pipeline.ts:38` -- unbounded image cache operations

Using unbounded concurrency for network calls could flood the Bluesky API. Cap to a reasonable limit (e.g., `concurrency: 10`).

### I2. Massive Image Caching Code Duplication

**Files:** `src/cli/sync-factory.ts:105-136`, `src/cli/sync.ts:517-549,880-910`, `src/cli/watch.ts:476-498,677-699,874-907`

The image caching block is copy-pasted at least 6 times. Extract into a shared helper:
```typescript
const runImageCache = (storeRef: StoreRef, sourceName: string, options: ImageCacheOptions) => ...
```

### I3. Degree Centrality Double-Counts for Undirected Graphs

**File:** `src/graph/centrality.ts:73-88`

For undirected graphs, `neighborsIn` is set equal to `neighborsOut`. When `direction === "both"`, the score becomes `2 * neighborsOut.length`, double-counting every edge. For undirected graphs with "both" direction, the degree should just be `neighborsOut.length`.

### I4. PostUri Lacks Post-Specific Validation

**File:** `src/domain/primitives.ts:27-31`

`PostUri` uses the same `at://` regex as `AtUri`. A post URI should validate against `at://did:*/app.bsky.feed.post/*`. Currently any AT URI passes as a `PostUri`, undermining the brand.

### I5. ActorId Missing Lowercase Transform

**File:** `src/domain/primitives.ts:42-46`

Unlike `Handle` (which applies `Schema.Lowercase` before pattern matching), `ActorId` does not lowercase input. A mixed-case handle like `"Alice.bsky.social"` would be accepted by `Handle` but rejected by `ActorId`, causing subtle validation inconsistencies.

### I6. Error Types Missing `message` Field

**Files:**
- `src/domain/errors.ts:74-82` -- `StoreNotFound`, `StoreAlreadyExists`
- `src/domain/errors.ts:102-105` -- `FilterNotFound`
- `src/domain/derivation.ts:48-55` -- `DerivationError` uses `reason` instead of `message`

The project convention states errors should have `message` + optional `cause`, `operation`, `status`. These errors lack human-readable message fields.

### I7. Inconsistent NonNegativeInt Definitions

**Files:**
- `src/domain/bsky.ts:105` -- includes `Schema.finite()`
- `src/domain/images.ts:5` -- missing `Schema.finite()`
- `src/domain/analytics.ts:4` -- missing `Schema.finite()`

The `bsky.ts` version rejects `Infinity` while the others accept it. Extract a single shared definition to `primitives.ts`.

### I8. Silent Error Swallowing in Image Cache and Store Renamer

**Files:**
- `src/services/images/image-cache.ts:203` -- `Effect.catchAll(() => Effect.void)` on archive removal
- `src/services/store-renamer.ts:199-230` -- all rollback errors silently discarded

Failed cleanup/rollback operations leave no trace. At minimum, log warnings for operational failures during cleanup.

### I9. SyncSettings vs DerivationSettings Inconsistency

**Files:**
- `src/services/sync-settings.ts:30` -- `yield* SyncSettingsOverrides` (hard fails if missing)
- `src/services/derivation-settings.ts:26-28` -- `yield* Effect.serviceOption(...)` (graceful fallback)

`SyncSettings` will crash if the overrides tag is missing from the layer graph. `DerivationSettings` gracefully defaults. One pattern should be chosen consistently.

### I10. StoreError Union Missing StoreSourcesError

**File:** `src/domain/errors.ts:117`

`StoreSourcesError` is defined in the same file but not included in the `StoreError` union type. Consumers matching on `StoreError` won't handle it.

### I11. Schema.Unknown Instead of Schema.Defect for Error Causes

**File:** `src/domain/errors.ts` -- all error definitions

The CLI errors correctly use `Schema.Defect` for cause fields, but all 14+ domain error classes use `Schema.Unknown`. `Schema.Defect` handles error serialization for logging/tracing more correctly.

### I12. EmbedRecordWithMedia.media Falls Back to Raw Schema.Unknown

**File:** `src/domain/bsky.ts:260`

```typescript
media: Schema.Union(EmbedImages, EmbedExternal, EmbedVideo, Schema.Unknown)
```

A dedicated `MediaUnknown` tagged class (like `EmbedUnknown`) would preserve raw data for debugging rather than silently accepting any value.

### I13. Silent Image Extraction Error Swallowing

**File:** `src/domain/embeds.ts:32-38`

```typescript
try {
  const decoded = Schema.decodeUnknownSync(EmbedImages)(value);
  return decoded.images.map(toImageRef);
} catch {
  return [];  // Images silently dropped
}
```

If the Bluesky API changes its image embed format, all images would silently disappear. Add logging or a fallback that preserves the raw data.

### I14. GraphBuilder Unbounded Memory Collection

**File:** `src/services/graph-builder.ts:91`

```typescript
const collected = yield* Stream.runCollect(limitedStream);
```

Without a limit, entire query results are collected into memory. For large stores this could exhaust available memory. Add a default upper bound.

### I15. StoreTopology N+1 Query Pattern

**File:** `src/services/store-topology.ts:56-80`

For N stores, makes 4N sequential operations (count + lineage + sources per store, then lineage again). Add concurrency and eliminate the duplicate lineage fetch.

### I16. `as any` Casts in Filter Schema Definitions

**File:** `src/domain/filter.ts:684,782`

Two `as any` casts on `FilterEngagementSchema` and `FilterDateRangeSchema` bypass TypeScript type checking. If filter logic drifts, the compiler won't catch it.

---

## Suggestions

### S1. Migrate to `Effect.Service` Pattern

**Impact: High (architectural)**

All 48+ services use the older `Context.Tag` pattern. Migrating to `Effect.Service` with `dependencies` would:
- Eliminate the 258-line `layers.ts` manual wiring file
- Make dependency relationships local to each service
- Reduce boilerplate (no manual `Layer.effect`/`Layer.scoped`/`ServiceName.of({...})`)

This is a large refactor -- consider doing it incrementally for new services first.

### S2. `storeSourceId` Should Use `Match.tagsExhaustive`

**File:** `src/domain/store-sources.ts:59-72`

Uses a plain `switch` without default. If a new source type is added, it would silently return `undefined`. `Match.tagsExhaustive` (used in `dataSourceKey`) provides compile-time exhaustiveness.

### S3. Replace `process.env` Access in Output Format Resolution

**File:** `src/cli/output-format.ts:41`

`resolveOutputFormat` reads `process.env.SKYGENT_OUTPUT_FORMAT` directly. This should go through Effect's config system for testability and consistency.

### S4. Add Retry Logic to Link Validator

**File:** `src/services/link-validator.ts`

HTTP validation has no retry logic. Transient failures immediately mark links as invalid and cache that result for 6 hours. A minimal 1-2 retry attempts would improve accuracy.

### S5. Add Missing Transient Error Codes to Retry Logic

**File:** `src/services/bsky-client.ts:397-418`

`isRetryableCause` checks for `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`. Missing: `ECONNREFUSED`, `ENETUNREACH`, `EPIPE`, `ENOTFOUND`.

### S6. Add Explicit API Call Timeouts

**File:** `src/services/bsky-client.ts`

Individual Bluesky API calls lack explicit timeouts. A stuck API call could block the entire sync pipeline.

### S7. Use `Effect.repeat` with `Schedule` Instead of `while(true)` Loop

**File:** `src/services/sync-engine.ts:538-569`

The heartbeat uses an imperative `while(true)` + `Effect.sleep` pattern. Replace with `Effect.repeat(Schedule.spaced(...))` for declarative composability.

### S8. Use `Effect.tryPromise({ try, catch })` Form Consistently

**File:** `src/services/bsky-client.ts` (~30 occurrences)

The shorthand `Effect.tryPromise(() => ...)` propagates raw `UnknownException`. The `{ try, catch }` form maps errors closer to their source. `credential-store.ts` already uses the recommended form.

### S9. Add Depth Limits on Recursive Filter Traversal

**File:** `src/domain/filter.ts`

Recursive functions (`isEffectfulFilter`, `countConditions`, `formatFilterExpr`, etc.) lack depth guards. A deeply nested filter (10,000+ levels) would cause stack overflow.

### S10. Redundant Manual Scope in StoreManager

**File:** `src/services/store-manager.ts:250-251`

`StoreManager.layer` is `Layer.scoped` but creates an additional manual `Scope.make()` with its own finalizer. The outer scope from `Layer.scoped` already handles cleanup. The manual scope adds unnecessary indirection.

### S11. Non-Idiomatic Mixed Return Type in retryScheduleFor

**File:** `src/services/filter-runtime.ts:187-192`

Returns either a `FilterEvalError` instance or a `Schedule` (mixed types). Should return an `Effect<Schedule, FilterEvalError>` for idiomatic error handling.

### S12. Volume Buckets in Digest Sorted by Count, Not Time

**File:** `src/cli/digest.ts:394`

Time-series volume buckets are sorted by count descending. Chronological order would be more natural for visualization.

---

## Test Coverage Gaps

### Suite Health
- **343 tests, 0 failures, 1631 assertions** across 77 files
- **~38,134 lines** of test code
- Strong property-based testing foundation (5 files)

### Untested Services (10)
| Service | Risk |
|---------|------|
| `store-db.ts` (connection pooling) | High -- concurrency logic only tested transitively |
| `store-commit.ts` (write transactions) | High -- contains the race condition from C1 |
| `store-index-sql.ts` (SQL generation) | High -- complex SQL pushdown logic |
| `post-parser.ts` | Medium |
| `sync-reporter.ts` | Low |
| `sync-checkpoint-store.ts` | Medium |
| `image-pipeline.ts` (orchestration) | Medium |
| `image-ref-index.ts` | Medium |
| `image-archive.ts` | Medium |
| `store-keys.ts` | Low |

### Untested CLI Commands (18+)
`query.ts`, `search.ts`, `feed.ts`, `actor.ts`, `config.ts`, `graph.ts`, `view.ts`, `view-thread.ts`, `post.ts`, `capabilities.ts`, `sync.ts`, `store.ts` (handlers), `compact-output.ts`, `stream-merge.ts`, `pagination.ts`, and more. Only `derive`, `watch`, `pipe`, `filter`, and `store` (integration) have test coverage.

### Untested Domain (7)
`config.ts`, `credentials.ts`, `defaults.ts`, `indexes.ts`, `text-width.ts`, `events.ts`, `store.ts`

### Test Infrastructure Issues
1. **`makeOutputCapture()` duplicated in 5+ files** -- extract to `tests/support/output-capture.ts`
2. **`makeTempDir()`/`removeTempDir()` duplicated in 10+ files** -- extract to shared support
3. **Sample data fixtures redefined everywhere** -- consolidate to `tests/support/fixtures.ts`
4. **`Effect.die("unused")` in mocks** masks bugs -- use `Effect.fail` with descriptive messages
5. **`globalThis.fetch` mutation** in `bsky-mock-server.ts` -- global state risk if tests run concurrently

### Recommended New Tests
- Property tests for `filterExprSignature` determinism, `PostOrder` transitivity, `dataSourceKey` stability
- Edge cases: empty streams in sync, concurrent derivations, unicode in DSL
- Stress test: `StoreIndex` at 10k+ posts
- Integration tests for `sync`, `query`, `filter` command groups

---

## Architecture Opportunities

### A1. Effect.Service Migration (High Impact)
Replace `Context.Tag` + manual layer wiring with `Effect.Service` + `dependencies`. Eliminates `layers.ts` (258 lines), makes deps local, reduces boilerplate. Do incrementally -- new services first.

### A2. Shared Sync/Watch Source Resolution
`src/cli/sync.ts` and `src/cli/watch.ts` have ~350 lines each with ~80% structural overlap for source resolution, list expansion, error handling, and result combining. Extract a shared `runStoreSources` helper.

### A3. Domain Barrel Export Completeness
`src/domain/index.ts` is missing re-exports for 13+ modules (`config.ts`, `format.ts`, `order.ts`, `filter-explain.ts`, `images.ts`, `embeds.ts`, `store-sources.ts`, `derivation.ts`, `indexes.ts`, `analytics.ts`, `graph.ts`, `text-width.ts`, `filter-describe.ts`).

### A4. CLI Domain Logic Extraction
Pure data operations like `storeSourceEquals` and `mergeStoreSource` in `src/cli/store.ts:219-340` should live in `src/domain/store-sources.ts` per the module boundary rules.

### A5. Query Command Decomposition
The `queryCommand` handler in `src/cli/query.ts:319-1101` is ~780 lines. Extract image extraction, count-by logic, JSON streaming, and thread rendering into separate functions.

---

## What Was Done Well

**Effect Patterns:**
- Consistent `Context.Tag("@skygent/Name")` with static `layer` throughout all 48+ services
- `Effect.fn` used with names everywhere, enabling excellent tracing
- Proper `Layer.scoped` / `Layer.effect` / `Layer.succeed` usage
- Correct double-check locking in `StoreDb.getClient`
- `SynchronizedRef.modifyEffect` for monotonic ULID generation in `StoreWriter`
- `RequestResolver.batchN` for profile resolution batching

**CLI UX:**
- Every command includes `withExamples()` help text
- Thorough validation of incompatible flag combinations with actionable error messages
- `looksLikeFilterExpression` catches filter/store-name mix-ups
- Global option misplacement detection
- Nearly every mutating command supports `--dry-run`
- Consistent compact vs full output toggle via `CliPreferences`

**Error Handling:**
- Error mapping at every service boundary
- Nested error causes preserved via `cause` field
- `StoreRenamer` implements proper rollback with `Effect.ensuring` + `Ref`-tracked state
- Non-critical errors (image caching) use `logWarn` + `Effect.orElseSucceed` resilience pattern

**Data Modeling:**
- Domain layer is pure -- zero imports from services or CLI
- `PostEmbed` union includes `EmbedUnknown` for forward compatibility
- `FeedReason` includes `FeedReasonUnknown` catch-all
- `FilterExprMonoid` with algebraic law tests in `monoid-laws.test.ts`
- `Redacted<String>` correctly used for credentials

**Database:**
- All SQL uses parameterized queries (no injection risk)
- WAL mode, busy_timeout, mmap, and `PRAGMA optimize` on shutdown
- Keyset pagination avoids offset performance issues
- `ON CONFLICT` upserts with monotonicity guards

**Testing:**
- 343 tests, 100% pass rate, 1631 assertions
- 5 property-based test files with algebraic law verification
- `TestClock` for time-dependent tests
- Proper `Layer.succeed` mocking with type-safe overrides
- `bsky-client.ts` mock uses `unused()` = `Effect.fail` to catch accidental calls

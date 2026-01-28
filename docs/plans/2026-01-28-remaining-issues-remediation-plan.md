# Remaining Issues Remediation Plan (Effect-Idiomatic)

**Date:** 2026-01-28
**Scope:** Issues list provided in conversation (1-15)
**Goal:** Produce a production-grade remediation spec with Effect-native patterns, tests, and phases.

## Executive Summary

We will address 15 issues in four phases. The biggest structural fixes are around event log storage (manifest bloat, sequential IO, orphaning) and concurrency/race safety (TOCTOU in sync, store manifest races). These are now largely addressed by moving event log + catalog metadata into **custom SQLite tables** (leveraging the existing SQL stack used by StoreIndex). Remaining high-severity risks are TOCTOU/atomicity in sync and signal-safe checkpointing.

**Phase focus:**
1. **Data integrity (critical):** TOCTOU in sync and event log/index atomicity.
2. **Reliability (critical):** Signal handling with interruption-safe checkpointing, derivation checkpointing.
3. **Performance:** Event log IO batching, stream backpressure, stats aggregation via SQL.
4. **UX / safety:** Regex ReDoS guardrails, secret redaction, env validation, default help text, deprecated option warnings.

## Status Update (2026-01-28)

Completed in the latest SQL migration work:
- **Event log moved to SQL** (`event_log`, `event_log_meta`) and streamed via pagination.
- **Store catalog moved to SQL** (`catalog.sqlite` with `stores` table).
- **StoreEventLog/StoreWriter/StoreManager/StoreIndex** now use the SQL-backed layers.
- **StoreCommitter** added to make event append + index update atomic.

High‑severity items now addressed:
- **TOCTOU in sync** is removed by atomic insert‑if‑missing at the DB layer.
- **Event log ↔ index atomicity** is enforced via a shared transaction.
- **Signal/interrupt checkpointing** is handled with finalizers on sync streams.

## Research Notes (Effect Sources Consulted)

Effect solutions topics reviewed: `services-and-layers`, `error-handling`, `config`, `testing`, `cli`.

Key Effect source references:

- **Timeouts & interruption**
  - `Effect.timeout`, `Effect.timeoutFail` in `.reference/effect/packages/effect/src/Effect.ts`.
  - `Effect.onInterrupt`, `Effect.addFinalizer`, `Effect.uninterruptibleMask` in `.reference/effect/packages/effect/src/Effect.ts`.
- **Streams + backpressure**
  - `Stream.buffer` / `Stream.bufferChunks` in `.reference/effect/packages/effect/src/Stream.ts`.
  - `Stream.interruptWhenDeferred` in `.reference/effect/packages/effect/src/Stream.ts`.
  - `Stream.mapEffect` supports `{ concurrency, bufferSize }` in `.reference/effect/packages/effect/src/Stream.ts`.
  - `Stream.unfoldEffect` for paginated SQL reads in `.reference/effect/packages/effect/src/Stream.ts`.
- **Queues**
  - `Queue.bounded`, `Queue.dropping`, `Queue.sliding` in `.reference/effect/packages/effect/src/Queue.ts`.
- **Request batching**
  - `RequestResolver.batchN`, `RequestResolver.makeBatched` in `.reference/effect/packages/effect/src/RequestResolver.ts`.
  - `Effect.withRequestBatching` in `.reference/effect/packages/effect/src/Effect.ts`.
- **Schedules**
  - `Schedule.exponential`, `Schedule.jittered`, `Schedule.recurs` in `.reference/effect/packages/effect/src/Schedule.ts`.
- **Redaction**
  - `Redacted` type + `Redacted.value` in `.reference/effect/packages/effect/src/Redacted.ts`.

Runtime note:
- `BunRuntime.runMain` delegates to `platform-node-shared` runtime, which installs SIGINT/SIGTERM handlers and interrupts the main fiber. However, we still need explicit checkpoint persistence on interrupt.

## Decision: Custom SQL Tables (Not SqlEventJournal)

We implemented **custom SQL tables** (instead of `SqlEventJournal`) to preserve full control over schema, indices, pagination, and transaction boundaries with StoreIndex updates. This keeps our domain model first-class and avoids a generic journal abstraction that returns full entry arrays.

### Per-store Event Log Schema (co-located with StoreIndex)

**Database:** use the same `index.sqlite` per store so event log writes and index updates can be wrapped in a **single transaction**.

**Tables (SQLite):**

```
event_log(
  event_id TEXT PRIMARY KEY,        -- ULID
  event_type TEXT NOT NULL,          -- PostUpsert | PostDelete
  post_uri TEXT NOT NULL,
  payload_json TEXT NOT NULL,        -- encoded PostEventRecord
  created_at TEXT NOT NULL,          -- ISO timestamp
  source TEXT NOT NULL               -- timeline/feed/notifications/derive/jetstream
)

event_log_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

**Indexes:**
- `event_log_created_at_idx` on `created_at`
- `event_log_post_uri_idx` on `post_uri`
- Optional `event_log_source_idx` on `source`

**Type-safe rows:** define `Schema.Struct` row shapes in `StoreEventLog` (or a new `EventLogRepo`) and use `SqlSchema.findAll/findOne/void` with those schemas for validation.

### Store Catalog Schema (global catalog DB)

**Database:** `catalog.sqlite` under `storeRoot` (one file for all stores).

```
stores(
  name TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  config_json TEXT NOT NULL
)
```

**Indexes:**
- `stores_name_idx` (implicit by primary key)

**Type-safe rows:** `Schema.Struct({ name, root, created_at, updated_at, config_json })` plus decoding `StoreConfig` JSON.

### Migrations

Implemented migrations:
- `src/db/migrations/store-index/002_event_log.ts`
- `src/db/migrations/store-catalog/001_init.ts`

### Why this design

- **Atomicity:** `SqlClient.withTransaction` can wrap event log insert + StoreIndex update.
- **Pagination:** SQL makes `LIMIT/OFFSET` or `event_id > last` streaming trivial.
- **Type safety:** `SqlSchema` + `Schema` can enforce payload shape.
- **No manifest bloat:** eliminates KVS `events/manifest` arrays entirely.

## Issue Matrix (Dependency + Phase)

| # | Issue | Severity | Primary Root Cause | Phase | Key Dependencies | Status |
|---|-------|----------|--------------------|-------|------------------|--------|
| 1 | TOCTOU race in sync | High | `hasUri` check separate from write | 1 | Atomic store write, index uniqueness | **Done** |
| 2 | Manifest memory bloat | High | Full manifest array in KVS | 1 | Custom SQL event log | **Done** |
| 3 | Sequential event log I/O | High | Per-key KV reads | 3 | SQL pagination | **Done** |
| 4 | Signal handling | High | No checkpoint on interrupt | 2 | Stream finalizers / onInterrupt | **Done** |
| 6 | Store manager manifest races | Medium | Non-atomic manifest modify | 1 | SQLite catalog | **Done** |
| 7 | Derivation no checkpointing | Medium | Save only at end | 2 | Stream mapAccum + finalizer | **Open** |
| 8 | Event log orphaning | Medium | Event write + manifest update not atomic | 1 | Transactional SQL event log | **Done** |
| 9 | Stream backpressure missing | Medium | Unbounded buffers | 3 | Stream.buffer / Queue.bounded | **Open** |
|10 | Regex ReDoS | Medium | No complexity limits | 4 | Validation rules / safe regex | **Deferred** (per user) |
|11 | Secrets leakage in errors | Medium | Error formatting prints raw values | 4 | Redaction helpers | **Open** |
|12 | Env var validation gap | Medium | Defaults hide misconfig | 4 | Config validation layer | **Open** |
|13 | Stats memory overhead | Low | Full index scan in memory | 3 | SQL aggregates | **Open** |
|14 | Missing defaults in help | Low | Options lack default metadata | 4 | CLI option defaults | **Open** |
|15 | Deprecated option handling | Low | No warnings | 4 | CLI arg inspection | **Open** |

## Remediation Details

### 1) TOCTOU Race in Sync
**Root cause:** `src/services/sync-engine.ts` (and `jetstream-sync.ts`) check `index.hasUri` in `prepareRaw` and again in `applyPrepared`, but storage is not atomic with index updates. Concurrent sync runs can write duplicates.

**Current state:** resolved by using a single SQL transaction for post insert + event log append.

**Implementation:**
- Removed `prepareRaw` `hasUri` check.
- Added `StoreCommitter.appendUpsertIfMissing`, using `INSERT ... ON CONFLICT DO NOTHING` to atomically decide if a post is new.
- Wrapped post insert + event log append in one transaction.

**Effect APIs:** `Effect.makeSemaphore` (optional in-process lock), `SqlClient.withTransaction`.

**Acceptance:** No duplicate posts or event log entries across concurrent sync runs; idempotent sync.

---

### 2) Manifest Memory Bloat
**Root cause:** `src/services/store-event-log.ts` loads full manifest array (`events/manifest`) into memory per stream run.

**Status:** **Done.** StoreEventLog now streams from SQL with pagination and no manifest.

**Verification:**
- Confirm stream uses `LIMIT` pagination and bounded page size.
- Confirm `event_log_meta` is used for `last_event_id` when present.

**Acceptance:** Event log streaming uses bounded memory regardless of log size.

---

### 3) Sequential Event Log I/O
**Root cause:** `StoreEventLog.stream` uses `Stream.mapEffect` and per-key KV gets, leading to N sequential reads.

**Status:** **Done.** SQL pagination provides batched reads per page.

**Acceptance:** Streaming reads are batched; throughput improves with large logs.

---

### 4) Signal/Interrupt Handling (Checkpoint Persistence)
**Root cause:** `BunRuntime.runMain` interrupts on SIGINT/SIGTERM, but streams do not persist checkpoints on interrupt.

**Current state:** `sync` and `jetstream` streams now ensure final checkpoint persistence via finalizers.

**Implementation:**
- Added `Effect.ensuring` in `SyncEngine.sync` to save checkpoints on interrupt.
- Added `Stream.ensuring` in `JetstreamSyncEngine.processStream` to persist last checkpoint on interrupt.
- Wrap sync/derive streams with `Stream.ensuringWith` to persist latest checkpoint on interruption.
- For long-running streams, add explicit interrupt sources using `Stream.interruptWhenDeferred` if we need cooperative shutdown signals beyond fiber interrupt.
- Standardize a `Shutdown` utility: optional `Deferred` + `Effect.onInterrupt` to trigger final checkpoints.

**Effect APIs:** `Effect.onInterrupt`, `Stream.ensuringWith`, `Stream.interruptWhenDeferred`.

**Acceptance:** Ctrl+C preserves last checkpoint without partial corruption.

---

### 6) Store Manager Manifest Races
**Root cause:** `src/services/store-manager.ts` updates store manifest via non-atomic `modify`, losing updates under concurrent create/delete.

**Status:** **Done.** Store catalog is now SQLite-backed (`catalog.sqlite`, `stores` table).

**Acceptance:** Concurrent create/delete cannot lose manifest entries.

---

### 7) Derivation No Checkpointing
**Root cause:** `src/services/derivation-engine.ts` only saves checkpoints at the end.

**Plan:**
- Introduce periodic checkpointing (count + time based) using `Stream.mapAccumEffect` or stateful `runFoldEffect` that triggers `checkpoints.save`.
- Ensure final checkpoint saved on `onInterrupt` / `ensuringWith`.
- Persist last processed source event id during the stream.

**Effect APIs:** `Stream.mapAccumEffect`, `Stream.ensuringWith`, `Clock.currentTimeMillis`.

**Acceptance:** Derivations resume near last checkpoint after crash/interrupt.

---

### 8) Event Log Orphaning
**Root cause:** Event log writes and index updates are not yet transactional together; a crash can leave an event present without corresponding index updates.

**Status:** **Done.** Event log append and index updates now share a single SQL transaction via `StoreCommitter`.

**Effect APIs:** `SqlClient.withTransaction`, `Effect.acquireRelease` for DB connection.

**Acceptance:** Event writes are atomic; no orphaned events.

---

### 9) Stream Backpressure Missing
**Root cause:** Several pipelines use unbounded buffers or unbounded concurrency (e.g., sync prepare, jetstream filter eval, output materialization).

**Plan:**
- Add `Stream.buffer({ capacity, strategy })` in high-volume streams (sync, jetstream).
- Use `Stream.mapEffect` with explicit `bufferSize` matching concurrency.
- For push sources, use `Queue.bounded` + `Stream.fromQueue` to enforce backpressure.
- Make buffer size configurable (env + CLI).

**Effect APIs:** `Stream.buffer`, `Queue.bounded`, `Stream.fromQueue`.

**Acceptance:** No unbounded memory growth under high throughput.

---

### 10) Regex ReDoS Vulnerability
**Root cause:** `FilterCompiler.validateRegex` only compiles regex; no complexity/size constraints.

**Plan:**
- Add safe-regex validation: length cap, group/quantifier caps, and ban nested quantifiers like `(a+)+`.
- Optionally switch to a safe regex engine (e.g., `re2`) if allowed.
- Add explicit error messages for rejected patterns.

**Effect APIs:** pure validation; no special Effect APIs needed.

**Acceptance:** Malicious regex cannot stall the process.

---

### 11) Secrets Leakage in Errors
**Root cause:** `index.ts` error formatting/logging may include raw values, and some errors embed config values.

**Plan:**
- Introduce `redactSecrets` helper that masks common patterns (API keys, tokens).
- Wrap error formatting and `logErrorEvent` to sanitize messages and metadata.
- Ensure config errors use `Redacted` and never expose `.value`.

**Effect APIs:** `Redacted`, `Effect.catchAll` for sanitization boundaries.

**Acceptance:** Errors/logs never emit raw secret values.

---

### 12) Env Var Validation Gap
**Root cause:** Many configs are optional with defaults; errors appear only when code paths execute.

**Plan:**
- Add a `ConfigCheck` layer that validates required envs for enabled features at startup or via `skygent config check`.
- Provide warnings when defaults are used for critical settings.
- Validate config early in CLI entrypoint for commands that depend on external services (Bluesky).

**Effect APIs:** `Config`, `Config.all`, `Config.validate` patterns.

**Acceptance:** Misconfigurations are detected before long-running operations.

---

### 13) Stats Memory Overhead
**Root cause:** `StoreStats.stats` loads all entries and aggregates in memory (`StoreIndex.entries`).

**Plan:**
- Use SQL aggregates directly:
  - `COUNT(*)`, `MIN(created_date)`, `MAX(created_date)`.
  - `GROUP BY author`, `GROUP BY hashtag` with `LIMIT` for top lists.
- Add SQL helper functions in StoreIndex or a new StatsRepo.

**Effect APIs:** `SqlClient` queries, `SqlSchema.findAll` with row schemas.

**Acceptance:** Stats run in bounded memory and scale with DB size.

---

### 14) Missing Default Values in Help
**Root cause:** CLI options lack default metadata; help output omits defaults.

**Plan:**
- Ensure all Options/Args use `withDefault` and `withDescription` where appropriate.
- Update help text to include env var names + defaults (for agentic use).

**Effect APIs:** `@effect/cli` `Options.withDefault`, `Args.withDefault`.

**Acceptance:** `--help` shows defaults for optional params.

---

### 15) Deprecated Option Handling
**Root cause:** Deprecated options are accepted silently.

**Plan:**
- Add a small `DeprecatedOptions` helper that inspects `process.argv` for deprecated flags and emits a warning log.
- Optionally map deprecated flags to new ones to preserve compatibility.

**Effect APIs:** `Effect.logWarning` + CLI pre-processing.

**Acceptance:** Using deprecated flags prints a warning and suggests replacement.

## Phased Implementation Plan

**Phase 1 (Data Integrity):** Issues 1, 2, 6, 8
- **Done:** SQL event log tables + migrations (per-store `index.sqlite`).
- **Done:** `StoreWriter` + `StoreEventLog` now use SQL.
- **Done:** `catalog.sqlite` for store metadata and migrated `StoreManager`.
- **Done:** event insert + index update are atomic; TOCTOU removed via insert‑if‑missing.

**Phase 2 (Reliability):** Issues 4, 7
- **Done:** interrupt‑safe checkpointing in sync + jetstream.
- Add shutdown hooks around long-running streams (if needed beyond interrupt finalizers).

**Phase 3 (Performance):** Issues 3, 9, 13
- **Done:** Event log stream pagination.
- Bounded buffers and queue-based backpressure.
- SQL aggregates for stats.

**Phase 4 (Safety + UX):** Issues 10, 11, 12, 14, 15
- Regex validation (deferred per current priority).
- Redaction in errors/logs.
- Config validation and help defaults.
- Deprecated option warnings.

## Testing Plan

- **Race safety:** Concurrency tests for sync and store manager manifest updates.
- **Event log:** Verify no orphaned events under simulated crashes.
- **Checkpointing:** Use `TestClock` to simulate time-based checkpoint intervals.
- **Backpressure:** Stress tests with `Queue.bounded` capacity to ensure no memory spike.
- **Regex safety:** Include test cases for common ReDoS patterns.
- **Secrets:** Golden tests to ensure redacted strings in logs.

## Open Questions / Decisions Needed

1. Are we allowed to add a safe regex dependency (e.g., `re2`), or must we implement heuristics?
2. Do we want to log deprecations as warnings or errors for agentic mode?

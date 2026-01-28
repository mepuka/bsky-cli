# Remaining Issues Remediation Plan (Effect-Idiomatic)

**Date:** 2026-01-28
**Scope:** Issues list provided in conversation (1-15)
**Goal:** Produce a production-grade remediation spec with Effect-native patterns, tests, and phases.

## Executive Summary

We will address 15 issues in four phases. The biggest structural fixes are around event log storage (manifest bloat, sequential IO, orphaning) and concurrency/race safety (TOCTOU in sync, store manifest races). These will be resolved most robustly by moving event log + catalog metadata into **custom SQLite tables** (leveraging the existing SQL stack used by StoreIndex), then layering in backpressure + shutdown handling to preserve checkpoints on interrupts.

**Phase focus:**
1. **Data integrity (critical):** TOCTOU in sync, event log orphaning, store manifest races, and manifest bloat (SQL-backed event log + transactional writes).
2. **Reliability (critical):** Signal handling with interruption-safe checkpointing, LLM timeouts, derivation checkpointing.
3. **Performance:** Event log IO batching, stream backpressure, stats aggregation via SQL.
4. **UX / safety:** Regex ReDoS guardrails, secret redaction, env validation, default help text, deprecated option warnings.

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

We will implement **custom SQL tables** (instead of `SqlEventJournal`) to preserve full control over schema, indices, pagination, and transaction boundaries with StoreIndex updates. This keeps our domain model first-class and avoids a generic journal abstraction that returns full entry arrays.

### Per-store Event Log Schema (co-located with StoreIndex)

**Database:** use the same `index.sqlite` per store so event log writes and index updates can be wrapped in a **single transaction**.

**Tables (SQLite):**

```
event_log(
  event_id TEXT PRIMARY KEY,        -- ULID
  event_type TEXT NOT NULL,          -- PostUpsert | PostDelete
  post_uri TEXT,                     -- nullable for deletes without uri? (should be NOT NULL for both)
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

Add new migrations:
- `src/db/migrations/store-event-log/001_init.ts`
- `src/db/migrations/store-catalog/001_init.ts`

### Why this design

- **Atomicity:** `SqlClient.withTransaction` can wrap event log insert + StoreIndex update.
- **Pagination:** SQL makes `LIMIT/OFFSET` or `event_id > last` streaming trivial.
- **Type safety:** `SqlSchema` + `Schema` can enforce payload shape.
- **No manifest bloat:** eliminates KVS `events/manifest` arrays entirely.

## Issue Matrix (Dependency + Phase)

| # | Issue | Severity | Primary Root Cause | Phase | Key Dependencies |
|---|-------|----------|--------------------|-------|------------------|
| 1 | TOCTOU race in sync | High | `hasUri` check separate from write | 1 | Atomic store write, index uniqueness |
| 2 | Manifest memory bloat | High | Full manifest array in KVS | 1 | Custom SQL event log |
| 3 | Sequential event log I/O | High | Per-key KV reads | 3 | SQL pagination |
| 4 | Signal handling | High | No checkpoint on interrupt | 2 | Stream finalizers / onInterrupt |
| 5 | LLM timeout missing | High | LLM calls unbounded | 2 | Effect.timeout + retry policy |
| 6 | Store manager manifest races | Medium | Non-atomic manifest modify | 1 | SQLite catalog |
| 7 | Derivation no checkpointing | Medium | Save only at end | 2 | Stream mapAccum + finalizer |
| 8 | Event log orphaning | Medium | Event write + manifest update not atomic | 1 | Transactional SQL event log |
| 9 | Stream backpressure missing | Medium | Unbounded buffers | 3 | Stream.buffer / Queue.bounded |
|10 | Regex ReDoS | Medium | No complexity limits | 4 | Validation rules / safe regex |
|11 | Secrets leakage in errors | Medium | Error formatting prints raw values | 4 | Redaction helpers |
|12 | Env var validation gap | Medium | Defaults hide misconfig | 4 | Config validation layer |
|13 | Stats memory overhead | Low | Full index scan in memory | 3 | SQL aggregates |
|14 | Missing defaults in help | Low | Options lack default metadata | 4 | CLI option defaults |
|15 | Deprecated option handling | Low | No warnings | 4 | CLI arg inspection |

## Remediation Details

### 1) TOCTOU Race in Sync
**Root cause:** `src/services/sync-engine.ts` checks `index.hasUri` in `prepareRaw` and again in `applyPrepared`, but storage is not atomic with index updates. Concurrent sync runs can write duplicates.

**Plan:**
- **Short-term guard:** move `hasUri` checks into a single atomic store step. Remove the `prepareRaw` `hasUri` check (avoid TOCTOU) and only check just-in-time before `append` in an exclusive store transaction.
- **Long-term fix:** implement **event log + index updates in a single SQL transaction** to guarantee `insert-if-absent` semantics.
  - Add unique constraint on `(uri)` in posts table (already exists) and only append event log row if post is newly inserted.
  - If an event log row is required even for duplicates, use `INSERT OR IGNORE` plus a deterministic event hash to prevent replays.

**Effect APIs:** `Effect.makeSemaphore` (optional in-process lock), `SqlClient.withTransaction`.

**Acceptance:** No duplicate posts or event log entries across concurrent sync runs; idempotent sync.

---

### 2) Manifest Memory Bloat
**Root cause:** `src/services/store-event-log.ts` loads full manifest array (`events/manifest`) into memory per stream run.

**Plan:**
- Replace KVS manifest with SQL event table (see schema above).
  - Stream via pagination (`LIMIT/OFFSET` or `event_id > last`) using `Stream.unfoldEffect`.
  - Maintain `event_log_meta` for last event id if needed.

**Effect APIs:** `Stream.unfoldEffect`, `SqlClient` queries.

**Acceptance:** Event log streaming uses bounded memory regardless of log size.

---

### 3) Sequential Event Log I/O
**Root cause:** `StoreEventLog.stream` uses `Stream.mapEffect` and per-key KV gets, leading to N sequential reads.

**Plan:**
- With SQL event log: use SQL pagination queries with a single query per page.
- If staying on KVS temporarily: group keys and fetch with `Effect.forEach` concurrency, then flatten.

**Effect APIs:** `Stream.grouped`, `Effect.forEach({ concurrency })`, `Stream.mapEffect`.

**Acceptance:** Streaming reads are batched; throughput improves with large logs.

---

### 4) Signal/Interrupt Handling (Checkpoint Persistence)
**Root cause:** `BunRuntime.runMain` interrupts on SIGINT/SIGTERM, but streams do not persist checkpoints on interrupt.

**Plan:**
- Wrap sync/derive streams with `Stream.ensuringWith` to persist latest checkpoint on interruption.
- For long-running streams, add explicit interrupt sources using `Stream.interruptWhenDeferred` if we need cooperative shutdown signals beyond fiber interrupt.
- Standardize a `Shutdown` utility: optional `Deferred` + `Effect.onInterrupt` to trigger final checkpoints.

**Effect APIs:** `Effect.onInterrupt`, `Stream.ensuringWith`, `Stream.interruptWhenDeferred`.

**Acceptance:** Ctrl+C preserves last checkpoint without partial corruption.

---

### 5) LLM Timeout Missing
**Root cause:** LLM calls in `src/services/llm.ts` are unbounded.

**Plan:**
- Add timeout config (e.g., `SKYGENT_LLM_TIMEOUT`, default 30s).
- Wrap calls in `Effect.timeoutFail` (custom timeout error) or `Effect.timeout`.
- Add retry policy with `Schedule.exponential` + `Schedule.jittered` for transient errors; keep retries bounded.
- Optional: circuit-breaker via `Ref` + `Clock` (open/half-open) if repeated failures occur.

**Effect APIs:** `Effect.timeoutFail`, `Effect.retry`, `Schedule.exponential`, `Schedule.jittered`.

**Acceptance:** LLM calls do not hang indefinitely; timeouts are typed and logged.

---

### 6) Store Manager Manifest Races
**Root cause:** `src/services/store-manager.ts` updates store manifest via non-atomic `modify`, losing updates under concurrent create/delete.

**Plan:**
- Move store catalog to SQLite (single `stores` table with unique name + metadata) and update with transactions.
- Short-term: guard `createStore` / `deleteStore` with a semaphore or a global lock file (optional if we move immediately).

**Effect APIs:** `Effect.makeSemaphore`, `SqlClient.withTransaction`.

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
**Root cause:** `src/services/store-writer.ts` writes event, last-id, then manifest; crash between steps leaves orphaned events.

**Plan:**
- Move event log to SQL and update event log + StoreIndex in a single transaction.
- Remove `events/manifest` and `events/last-id` keys entirely once SQL path is active.

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
- Validate config early in CLI entrypoint for commands that depend on external services (LLM, Bluesky).

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
- Add SQL event log tables + migrations (per-store `index.sqlite`).
- Update `StoreWriter` + `StoreEventLog` to use SQL, ensure atomic writes with StoreIndex updates.
- Add `catalog.sqlite` for store metadata and migrate `StoreManager`.
- Remove TOCTOU by idempotent insert semantics.

**Phase 2 (Reliability):** Issues 4, 5, 7
- Add interrupt-safe checkpointing in sync + derivation.
- Add LLM timeouts + retry policy.
- Add shutdown hooks around long-running streams.

**Phase 3 (Performance):** Issues 3, 9, 13
- Event log stream pagination.
- Bounded buffers and queue-based backpressure.
- SQL aggregates for stats.

**Phase 4 (Safety + UX):** Issues 10, 11, 12, 14, 15
- Regex validation.
- Redaction in errors/logs.
- Config validation and help defaults.
- Deprecated option warnings.

## Testing Plan

- **Race safety:** Concurrency tests for sync and store manager manifest updates.
- **Event log:** Verify no orphaned events under simulated crashes.
- **Checkpointing:** Use `TestClock` to simulate time-based checkpoint intervals.
- **LLM timeouts:** Simulate hung LLM with `Effect.never` and assert timeout.
- **Backpressure:** Stress tests with `Queue.bounded` capacity to ensure no memory spike.
- **Regex safety:** Include test cases for common ReDoS patterns.
- **Secrets:** Golden tests to ensure redacted strings in logs.

## Open Questions / Decisions Needed

1. Are we allowed to add a safe regex dependency (e.g., `re2`), or must we implement heuristics?
2. Do we want to log deprecations as warnings or errors for agentic mode?

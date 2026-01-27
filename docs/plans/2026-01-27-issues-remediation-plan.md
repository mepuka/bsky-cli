# Issues Remediation Plan (Effect‑Idiomatic)

**Date:** 2026-01-27  
**Scope:** docs/issues/001–005  
**Status:** Draft for review

## Goals

1. Eliminate data‑integrity risks in store indexing and concurrent syncs.
2. Make syncs resumable and cost‑efficient (checkpointing + LLM batching).
3. Establish a scalable indexing strategy with an Effect‑native storage backend.
4. Improve CLI usability while preserving agentic JSON output defaults.

## Research Summary (Effect‑native primitives)

This plan is informed by the local Effect reference tree in `.reference/effect` and the codebase:

- **Resource lifecycles:** `Effect.acquireRelease` is the canonical scoped resource pattern and ensures finalizers run on interruption. (`.reference/effect/packages/effect/src/Effect.ts`)
- **Concurrency control:** `Effect.makeSemaphore` and `Semaphore.withPermits(1)` provide a mutex for write‑critical sections. (`Effect.ts`, Semaphore section)
- **Incremental stream state:** `Stream.mapAccumEffect` is the idiomatic way to evolve state while streaming and perform effects at each step (used for incremental checkpoints). (`Stream.ts`)
- **Stream finalizers:** `Stream.ensuring` / `Stream.ensuringWith` allow cleanup or persistence even on interruption. (`Stream.ts`)
- **TTY UX:** `@effect/platform/Terminal` provides `isTTY` and `readLine` for interactive prompts and human‑readable output. (`Terminal.ts`)
- **KV Store limitation:** `KeyValueStore` has no `scan` / prefix listing, so prefix‑key indexing cannot be done without changing the backend. (`KeyValueStore.ts`)

## Current State

- A **per‑store file lock** was added to serialize `sync`/`watch` across processes (prevents cross‑process races). This is correct and aligns with `Effect.acquireRelease` scoping.
- Store index updates remain **read‑modify‑write**, which is unsafe under in‑process concurrency and is O(N) for growing lists.

## Issues and Validations

### 001 — Storage scalability (O(N) index writes)
- **Valid.** `upsertList` reads and re‑writes entire JSON arrays. Complexity grows quadratically over many posts.
- **Constraint:** KV store cannot scan keys → prefix‑key indexing not viable without a new backend.

### 002 — Sync checkpointing only on completion
- **Valid.** Checkpoints saved only after stream completes; interruption loses progress.

### 003 — LLM batching ineffective due to sequential processing
- **Valid.** Sequential `Stream.mapEffect` prevents request batching.
- **Blocked by 004** until store writes are concurrency‑safe.

### 004 — Store index concurrency safety violation
- **Valid.** `upsertList` is read‑modify‑write with no mutex.
- **Cross‑process** concurrency fixed by store lock; **in‑process** still unsafe if we enable concurrency for batching.

### 005 — Usability improvements
- **Valid.** CLI is JSON‑only and non‑interactive, which is machine‑friendly but harsh for human UX.

## Phased Remediation Plan

### Phase 0 — Spec + Safety Baselines (this document)
- Confirm all acceptance criteria and migrate into implementation issues.
- Ensure lock usage remains per‑store and scoped to command lifetimes.

### Phase 1 — In‑Process Index Mutex (unblocks batching safely)

**Goal:** Make `StoreIndex` write operations safe under concurrency.

- Add a **store‑scoped semaphore** in `StoreIndex`.
- Wrap `applyUpsert` / `applyDelete` in `semaphore.withPermits(1)`.
- Use a `Ref<HashMap<StoreName, Semaphore>>` so each store has a dedicated mutex.

**Effect idioms**
- `Effect.makeSemaphore(1)` to create a mutex.
- `Semaphore.withPermits(1)` for critical sections.

**Acceptance criteria**
- Concurrent in‑process write operations do not corrupt index.
- Existing tests still pass; add a targeted concurrency test if feasible.

### Phase 2 — Sync Checkpointing + LLM Batching (Prepare/Apply split)

**Goal:** Make sync resilient and cost‑efficient.

**Approach**
- Use `Stream.groupedWithin` or `Stream.mapAccumEffect` in `SyncEngine`.
- Split processing into **prepare** (parse + filter + LLM) and **apply** (store writes).
- Run prepare concurrently with `Effect.withRequestBatching(true)` and bounded concurrency.
- Apply sequentially (or via the StoreIndex mutex if needed) to preserve correctness.

**Effect idioms**
- `Stream.mapAccumEffect` for incremental checkpoint saves.
- `Stream.ensuring` to persist final checkpoint on interruption.
- `Effect.forEach(... { batching: true, concurrency: n })` for LLM batching.

**Acceptance criteria**
- Checkpoints saved periodically during long syncs.
- Resume after interruption starts near last checkpoint.
- LLM batching reduces request count in batch strategy.

### Phase 3 — Storage Scalability (Index backend upgrade)

**Goal:** Remove O(N) list behavior and scale to large datasets.

Detailed design: docs/plans/2026-01-27-store-index-sqlite-plan.md

**Option A (short‑term KV)**
- Shard index lists into fixed‑size segments.
- Maintain a segment manifest per index.
- Update query and rebuild logic accordingly.

**Option B (preferred)**
- Implement `StoreIndexBackend` using SQLite (bun:sqlite or `@effect/sql-sqlite-bun`).
- Store per‑index rows and add SQL indexes.
- Keep `StoreIndex` interface stable, swap backend via Layer.

**Acceptance criteria**
- Index update cost is near O(1) per post.
- Index queries remain correct and bounded in memory.

### Phase 4 — CLI Usability Improvements

**Goal:** Keep agent‑friendly JSON defaults but improve human UX.

- If `Terminal.isTTY`, use human‑readable logs; otherwise JSON.
- Add interactive confirmation for `store delete` when TTY and `--force` missing.
- Add `config check` command to validate creds, LLM keys, and store root.

**Effect idioms**
- `Terminal.isTTY`, `Terminal.readLine`, `Terminal.display`.

**Acceptance criteria**
- Humans get readable logs and prompts; agent workflows unchanged.

## Testing Strategy

- **Unit tests** for concurrency: simulate parallel apply operations and ensure no data loss.
- **Integration tests** for checkpointing: interrupt mid‑sync and resume; verify no reprocessing.
- **LLM batching**: instrumentation or mocked RequestResolver to assert batch sizes.
- **CLI UX**: TTY vs non‑TTY behavior in tests (platform mocks).

## Risks & Mitigations

- **Mutex reduces throughput:** keep prepare phase concurrent and apply sequential. This keeps correctness and still enables LLM batching.
- **KV sharding complexity:** mitigate by moving to SQLite backend where possible.
- **Behavior changes in CLI:** keep JSON output as default for non‑TTY to preserve agent workflows.

## Decision Points

1. **Index backend**: short‑term sharding vs SQLite migration.
2. **Checkpoint frequency**: per chunk, time‑based, or both.
3. **LLM batching concurrency limit**: define initial safe default (e.g. 5–10).

## Proposed Deliverables

- Phase 1 PR: StoreIndex mutex + tests.
- Phase 2 PR: SyncEngine batching + incremental checkpoints + tests.
- Phase 3 PR: Index backend refactor (SQLite or sharded KV) + migration path.
- Phase 4 PR: CLI UX enhancements + tests + docs.

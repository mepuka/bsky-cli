# Issues Remediation Plan (Effect-Idiomatic)

**Date:** 2026-01-27  
**Scope:** docs/issues/001-005  
**Status:** Updated after SQLite StoreIndex implementation

## Executive Summary

- **Resolved:** Issue 001 (storage scalability) and Issue 004 (store index concurrency) are addressed by the SQLite StoreIndex backend now in `src/services/store-index.ts` + migrations in `src/db/migrations/store-index/`.
- **Open:** Issue 002 (incremental checkpointing), Issue 005 (CLI UX improvements).
- **Next:** Implement incremental checkpoints in `SyncEngine`, then CLI UX improvements.

## Research Notes (Effect References)

Sources consulted:
- `effect-solutions show` topics: basics, services-and-layers, error-handling, config, testing, cli.
- `.reference/effect/docs/index.md` (local docs index; high-level overview with external links).
- `.reference/effect`:
  - `Stream.ensuring` / `Stream.ensuringWith` and `Stream.mapAccumEffect` (Stream.ts) for interruption-safe checkpointing.
  - `Stream.mapEffect` options including `concurrency` (Stream.ts) for parallel processing.
  - `Effect.withRequestBatching` (Effect.ts) and `RequestResolver.makeBatched` / `batchN` (RequestResolver.ts) for batching.
  - `Terminal.isTTY`, `Terminal.readLine`, `Terminal.display` (@effect/platform/Terminal.ts) for interactive UX.

These are the APIs we will use in the remediation steps below.

### Effect Source References (paths + key signatures)

**Stream checkpointing and finalizers**
- `Stream.mapAccumEffect`  
  `.reference/effect/packages/effect/src/Stream.ts`  
  ```
  export const mapAccumEffect: {
    <S, A, A2, E2, R2>(
      s: S,
      f: (s: S, a: A) => Effect.Effect<readonly [S, A2], E2, R2>
    ): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>
  }
  ```
- `Stream.ensuringWith`  
  `.reference/effect/packages/effect/src/Stream.ts`  
  ```
  export const ensuringWith: {
    <E, R2>(
      finalizer: (exit: Exit.Exit<unknown, E>) => Effect.Effect<unknown, never, R2>
    ): <A, R>(self: Stream<A, E, R>) => Stream<A, E, R2 | R>
  }
  ```
- `Stream.groupedWithin` (optional chunk/time checkpointing)  
  `.reference/effect/packages/effect/src/Stream.ts`  
  ```
  export const groupedWithin: {
    (chunkSize: number, duration: Duration.DurationInput):
      <A, E, R>(self: Stream<A, E, R>) => Stream<Chunk.Chunk<A>, E, R>
  }
  ```

**Stream concurrency for batching**
- `Stream.mapEffect` concurrency options  
  `.reference/effect/packages/effect/src/Stream.ts`  
  ```
  export const mapEffect: {
    <A, A2, E2, R2>(
      f: (a: A) => Effect.Effect<A2, E2, R2>,
      options?: { concurrency?: number | "unbounded"; unordered?: boolean }
    ): <E, R>(self: Stream<A, E, R>) => Stream<A2, E2 | E, R2 | R>
  }
  ```

**Request batching controls**
- `Effect.withRequestBatching`  
  `.reference/effect/packages/effect/src/Effect.ts`  
  ```
  export const withRequestBatching: {
    (requestBatching: boolean): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  }
  ```
- `RequestResolver.makeBatched` / `RequestResolver.batchN`  
  `.reference/effect/packages/effect/src/RequestResolver.ts`  
  ```
  export const makeBatched: <A extends Request.Request<any, any>, R>(
    run: (requests: NonEmptyArray<A>) => Effect.Effect<void, never, R>
  ) => RequestResolver<A, R>

  export const batchN: {
    (n: number): <A, R>(self: RequestResolver<A, R>) => RequestResolver<A, R>
  }
  ```

**TTY-aware CLI UX**
- `Terminal` service contract  
  `.reference/effect/packages/platform/src/Terminal.ts`  
  ```
  export interface Terminal {
    readonly isTTY: Effect<boolean>
    readonly readLine: Effect<string, QuitException>
    readonly display: (text: string) => Effect<void, PlatformError>
  }
  ```

## Status Matrix

| Issue | Status | Evidence |
| --- | --- | --- |
| 001 Storage scalability | **Resolved** | StoreIndex now backed by SQLite with indexes and migrations; no JSON list rewrites. |
| 002 Sync checkpointing | **Implemented** | Incremental checkpointing in `SyncEngine` with count + interval triggers. |
| 004 Store concurrency | **Resolved** | SQLite transactions replace non-atomic KV updates. |
| 005 CLI UX | **Implemented** | TTY-aware logs, interactive delete prompt, and `skygent config check`. |

## Implemented Changes (Issue 001 + 004)

**Summary**
- `StoreIndex` now uses SQLite via `@effect/sql` + `@effect/sql-sqlite-bun`.
- Per-store DB stored at `${storeRoot}/${store.root}/index.sqlite`.
- Migrations create `posts`, `post_hashtag`, `index_checkpoints` with indexes.
- Writes are transactional and no longer read-modify-write on shared lists.

**Acceptance criteria met**
- Index updates are O(1) per post (insert/update rows).
- Index reads no longer allocate large JSON arrays.
- Concurrency-safe writes (SQLite transactions) remove KV corruption risk.

## Remaining Work: Production Spec

### Issue 002: Incremental Sync Checkpointing

**Goal**
Persist checkpoints periodically so long syncs can resume without full replay.

**Requirements**
- Save checkpoint after a configurable number of processed posts (count-based).
- Save checkpoint after a configurable time interval (time-based).
- Ensure a final checkpoint is saved on completion or interruption.
- Maintain backward compatibility with current checkpoint schema.

**Design**
1. **State model**
   - Track `processed`, `stored`, `skipped`, `errors`, `lastEventId`, and `cursor` as part of stream state.
2. **Streaming algorithm**
   - Use `Stream.mapAccumEffect` to evolve state for each post.
   - Compute `shouldCheckpoint` when either:
     - `processed % checkpointEvery === 0`, or
     - `now - lastCheckpointAt >= checkpointIntervalMs`.
   - When `shouldCheckpoint`, call `SyncCheckpointStore.save` with current state.
3. **Interruption safety**
   - Use `Stream.ensuringWith` to persist the latest checkpoint on interruption (if any progress was made).
4. **Error handling**
   - Checkpoint errors are fatal for sync (store failure indicates inconsistent state).
   - Non-store errors still count toward error metrics and are appended to result.

**Proposed API/config**
- `SKYGENT_SYNC_CHECKPOINT_EVERY` (default: 100)
- `SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS` (default: 5000)
- CLI options: `--checkpoint-every`, `--checkpoint-interval-ms`

**Acceptance criteria**
- Killing sync mid-run resumes within the last checkpoint interval.
- Checkpoints persist even when stream exits via interrupt or error.
- Tests verify incremental save cadence and resume correctness.

---

### Issue 005: CLI Usability Improvements

**Goal**
Improve human UX without breaking agent-friendly JSON defaults.

**Requirements**
- Human-readable logs when stderr is a TTY.
- JSON output preserved for non-TTY or `--log-format=json`.
- Interactive confirmation for `store delete` when TTY and `--force` missing.
- Add `config check` command.

**Design**
1. **Logging**
   - Use `Terminal.isTTY` to select default log formatter.
   - Add `--log-format=json|human` with `human` only when TTY.
2. **Store delete prompt**
   - If TTY and `--force` missing, prompt: `Delete store <name>? [y/N]`.
   - Use `Terminal.readLine` and handle `QuitException` as a safe cancel.
3. **Config check**
   - Add `skygent config check`:
     - Validate credentials key format.
     - Validate Bluesky auth.
     - Validate store root is writable.

**Acceptance criteria**
- TTY users see readable logs, non-TTY stays JSON.
- Delete is safe and interactive by default for humans.
- `config check` reports actionable diagnostics.

## Testing Plan

**Checkpointing**
- Unit: checkpoint saved every N items and at time intervals.
- Integration: simulate mid-stream interruption, resume near last checkpoint.

**CLI UX**
- Mock `Terminal.isTTY` true/false.
- Assert log formatting and interactive prompts.

## Rollout and Migration

**StoreIndex**
- SQLite index is already in use.
- For existing stores, `StoreIndex` bootstrap rebuilds from event log if DB is empty.

**SyncEngine changes**
- Backward compatible: checkpoint schema remains unchanged.
- New config options have defaults that maintain current behavior if unset.

## Risks and Mitigations

- **Checkpoint overhead:** mitigate with count/time thresholds.
- **CLI behavior change:** only apply interactive flow when TTY.

## Deliverables

1. **SyncEngine checkpointing + batching** (Issue 002 + 003)
2. **CLI UX improvements** (Issue 005)
3. **Documentation updates** to README and CLI help

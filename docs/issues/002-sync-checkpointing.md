# Data Loss Risk: Sync Checkpoints Only Saved on Completion

**Severity:** High
**Type:** Reliability / Bug
**File:** `src/services/sync-engine.ts`

## Description

The `SyncEngine` only saves the synchronization checkpoint (cursor position and last event ID) after the entire sync stream has been processed successfully. It does not update the checkpoint incrementally while the stream is running.

```typescript
// src/services/sync-engine.ts

// ... stream definition ...
const state = yield* stream.pipe(
  Stream.mapError(toSyncError("source", "Source stream failed")),
  Stream.mapEffect(processRaw),
  Stream.runFoldEffect(
    // ... accumulates state until stream ends ...
  )
);

// Checkpoint saving happens ONLY here, after stream completion
const shouldSave = Option.isSome(lastEventId) || Option.isSome(activeCheckpoint);
if (shouldSave) {
  // ... save checkpoint ...
}
```

## Impact

*   **No Resume Capability:** If a long-running sync operation (e.g., syncing a full timeline or a large feed) is interrupted by a crash, network failure, or user cancellation (Ctrl+C), **all progress is lost**.
*   **Redundant Processing:** The next sync attempt will fail to find an updated checkpoint and will restart from the beginning (or the last successful run), re-downloading and re-processing previously handled data. This wastes bandwidth, API limits, and LLM costs.

## Recommendation

Implement periodic checkpointing during stream processing.

1.  **Chunked Processing:** Process the stream in chunks (e.g., matching the API page size or a fixed number of items).
2.  **Incremental Saves:** Persist the `SyncCheckpoint` after successfully processing each chunk.
3.  **Graceful Shutdown:** Ensure checkpoints are saved even if the stream is interrupted, if possible, or rely on the last incremental save.

Ideally, the stream loop should look closer to:
```typescript
stream.pipe(
  Stream.tap((item) => ...), // process
  Stream.tap((item) => saveCheckpoint(...)) // periodic save
)
```
Or use `Stream.mapAccumEffect` to carry state and save periodically.

# Ineffective LLM Batching due to Sequential Processing

**Severity:** Medium
**Type:** Performance / Bug
**File:** `src/services/sync-engine.ts`

## Description

The `SyncEngine` processes posts sequentially using `Stream.mapEffect` with default concurrency (1). This behavior prevents the `RequestResolver` in `LlmDecision` from aggregating multiple requests into a single batch, effectively disabling the "Batch" strategy even when explicitly configured.

Effect's `RequestResolver` relies on concurrent requests occurring within a short time window (typically the same microtask) to form a batch. With sequential processing, each request completes before the next one begins.

```typescript
// src/services/sync-engine.ts

const state = yield* stream.pipe(
  Stream.mapError(toSyncError("source", "Source stream failed")),
  Stream.mapEffect(processRaw), // <--- Default concurrency is 1 (sequential)
  Stream.runFoldEffect(...)
);
```

## Impact

*   **Higher Costs:** System prompts and overhead are paid for every single post instead of being amortized across a batch.
*   **Lower Throughput:** The system incurs the full network latency for every LLM call, rather than parallelizing them.
*   **Broken Feature:** The `SKYGENT_LLM_STRATEGY="batch"` configuration does not function as intended during sync operations.

## Recommendation

Update `Stream.mapEffect` to use a higher concurrency level (e.g., `{ concurrency: "unbounded" }` or a fixed limit like 10).

**Critical Warning:** Enabling concurrency currently poses a severe data corruption risk due to the non-atomic nature of `StoreIndex` updates (see related Storage Scalability issue). The storage layer **must** be made thread-safe (e.g., via locking or atomic operations) before increasing sync concurrency.

# Concurrency Safety Violation in Store Index

**Severity:** Critical
**Type:** Bug / Data Integrity
**File:** `src/services/store-index.ts`

## Description

The `StoreIndex` service uses a read-modify-write pattern for updating index lists (`upsertList`) that is not atomic and lacks locking mechanisms.

```typescript
// src/services/store-index.ts

const upsertList = (...) =>
  store.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => store.set(key, [uri]),
        onSome: (current) =>
          // ... check existence ...
          store.set(key, [...current, uri])
      })
    )
  );
```

There is no mechanism preventing two concurrent operations from reading the same `current` value, appending their respective URIs, and then writing back, with the last write overwriting the previous one (Last Write Wins).

## Impact

*   **Data Corruption:** If multiple posts are processed concurrently, index updates will be lost. Posts will be missing from time-based or hashtag-based queries.
## Recommendation

*   **Short Term:** Wrap index updates in a `Semaphore` (limit 1) or `Resource` to ensure mutual exclusion during the read-modify-write cycle.
*   **Long Term:** Adopt a storage model that supports atomic appends or does not require read-modify-write on shared keys (e.g., SQLite or the prefix-based approach mentioned in Issue #001).

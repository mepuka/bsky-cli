# Critical Performance Issue: O(N) Index Operations on Store Write

**Severity:** High
**Type:** Performance / Bug
**File:** `src/services/store-index.ts`

## Description

The current `StoreIndex` implementation stores index entries (lists of URIs) as single JSON arrays in the KeyValueStore. Specifically, the global URI list (`indexes/uris`) and date-based indexes (`indexes/by-date/...`) grow linearly with the number of posts.

The `upsertList` function performs a full read-modify-write cycle for every indexed post. This involves:
1. Reading the entire list from the underlying store.
2. Deserializing the JSON array.
3. Scanning the array to check for existence (`current.includes(uri)`).
4. Appending the new item.
5. Serializing the new array.
6. Writing the entire array back to the store.

```typescript
// src/services/store-index.ts

const upsertList = (
  store: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  key: string,
  uri: PostUri
) =>
  store.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => store.set(key, [uri]),
        onSome: (current) =>
          current.includes(uri) // O(N) scan
            ? Effect.void
            : store.set(key, [...current, uri]) // O(N) write
      })
    )
  );
```

## Impact

*   **Quadratic Complexity:** Syncing N posts results in O(N^2) complexity for IO and serialization.
*   **Performance Degradation:** As the store grows (e.g., beyond a few thousand posts), sync speed will drop dramatically.
*   **Memory/IO Limits:** The `indexes/uris` key will eventually become too large to efficiently load into memory or write atomically, potentially leading to data corruption or crashes.

## Recommendation

Refactor the storage model to avoid maintaining monolithic lists for indexes.

**Option A: Prefix-based Indexing (KeyValueStore friendly)**
Instead of `key -> [uri1, uri2]`, use `key/uri1 -> empty`.
*   Check existence: `store.has(key/uri1)` (O(1)).
*   Insert: `store.set(key/uri1, empty)` (O(1)).
*   List: `store.scan(prefix)` (O(N) to list, but O(1) to write).

**Option B: Embedded Database**
Switch the storage backend from a raw KeyValueStore to an embedded database like SQLite (supported by Bun and Effect). This would allow standard SQL indexing and efficient queries.

# Store Derivation CLI Test Results

**Date**: 2026-01-26
**Test Scope**: End-to-end testing of store derivation feature with real data
**Source Store**: my-timeline (5,514 posts)

## Test Summary

✅ **8/9 tests passed**
❌ **1 bug discovered** (filed as skygent-bsky-tuy)

---

## Test Results

### Test 1: Author Filter ✅

**Filter**: `{"_tag":"Author","handle":"atrupar.com"}`
**Result**: 131 matched out of 4,699 processed
**Verification**: All results confirmed from atrupar.com author

```bash
$ bun run index.ts derive my-timeline author-atrupar --filter-json '{"_tag":"Author","handle":"atrupar.com"}'
{"source":"my-timeline","target":"author-atrupar","mode":"EventTime","result":{"eventsProcessed":4699,"eventsMatched":131,"eventsSkipped":4568,"deletesPropagated":0,"durationMs":1236}}

$ bun run index.ts query author-atrupar --format json | jq '[.[] | .author] | unique'
["atrupar.com"]
```

**Status**: ✅ PASS - Filter correctly isolates posts from single author

---

### Test 2: Hashtag Filter ✅

**Filter**: `{"_tag":"Hashtag","tag":"#Econ"}`
**Result**: 1 matched out of 4,699 processed
**Verification**: Result contains #Econ hashtag

```bash
$ bun run index.ts derive my-timeline hashtag-econ --filter-json '{"_tag":"Hashtag","tag":"#Econ"}'
{"source":"my-timeline","target":"hashtag-econ","mode":"EventTime","result":{"eventsProcessed":4699,"eventsMatched":1,"eventsSkipped":4698,"deletesPropagated":0,"durationMs":1097}}

$ bun run index.ts query hashtag-econ --format json | jq '.[] | .hashtags'
["#Econ", "#EconSky"]
```

**Status**: ✅ PASS - Hashtag filter works correctly

---

### Test 3: OR Filter (Multiple Hashtags) ✅

**Filter**: `{"_tag":"Or","left":{"_tag":"Hashtag","tag":"#Econ"},"right":{"_tag":"Hashtag","tag":"#ACA"}}`
**Result**: 2 matched (1 with #Econ, 1 with #ACA)
**Verification**: One post has #Econ, other has #ACA

```bash
$ bun run index.ts query hashtag-multiple --format json | jq '.[] | {author, hashtags}'
{
  "author": "charlesgaba.com",
  "hashtags": ["#ACA"]
}
{
  "author": "joebrusuelas.bsky.social",
  "hashtags": ["#Econ", "#EconSky"]
}
```

**Status**: ✅ PASS - OR logic works correctly

---

### Test 4: AND Filter (Author + Hashtag) ✅

**Filter**: `{"_tag":"And","left":{"_tag":"Author","handle":"joebrusuelas.bsky.social"},"right":{"_tag":"Hashtag","tag":"#Econ"}}`
**Result**: 1 matched (meets both criteria)
**Verification**: Post from joebrusuelas with #Econ hashtag

```bash
$ bun run index.ts query author-and-hashtag --format json | jq '.[] | {author, hashtags}'
{
  "author": "joebrusuelas.bsky.social",
  "hashtags": ["#Econ", "#EconSky"]
}
```

**Status**: ✅ PASS - AND logic works correctly

---

### Test 5: NOT Filter ✅

**Filter**: `{"_tag":"Not","expr":{"_tag":"Author","handle":"atrupar.com"}}`
**Result**: 4,568 matched (all non-atrupar posts)
**Verification**: Zero atrupar posts in results

```bash
$ bun run index.ts derive my-timeline not-atrupar --filter-json '{"_tag":"Not","expr":{"_tag":"Author","handle":"atrupar.com"}}'
{"eventsProcessed":4699,"eventsMatched":4568,"eventsSkipped":131}

$ bun run index.ts query not-atrupar --format json | jq '[.[] | select(.author == "atrupar.com")] | length'
0
```

**Status**: ✅ PASS - NOT logic correctly inverts filter

---

### Test 6: Regex Filter ✅

**Filter**: `{"_tag":"Regex","patterns":["[Tt]rump"]}`
**Result**: 257 matched out of 4,699 processed
**Verification**: All results contain "Trump" or "trump"

```bash
$ bun run index.ts derive my-timeline regex-trump --filter-json '{"_tag":"Regex","patterns":["[Tt]rump"]}'
{"eventsProcessed":4699,"eventsMatched":257,"eventsSkipped":4442}

$ bun run index.ts query regex-trump --format json | jq '[.[] | select(.text | test("[Tt]rump"; "i") | not)] | length'
0
```

**Status**: ✅ PASS - Regex pattern matching works correctly

---

### Test 7: Incremental Derivation ✅

**Scenario**: Add new posts to source, verify only new events processed

1. Initial state: 4,699 posts in my-timeline
2. Synced additional posts: 5,514 total (+815 new)
3. View status changed from "ready" to "stale"
4. Re-ran derivation: processed only 815 new events

```bash
$ bun run index.ts view status hashtag-econ my-timeline
{"view":"hashtag-econ","source":"my-timeline","status":"stale"}

$ bun run index.ts derive my-timeline hashtag-econ --filter-json '{"_tag":"Hashtag","tag":"#Econ"}'
{"eventsProcessed":815,"eventsMatched":0,"eventsSkipped":815}

$ bun run index.ts view status hashtag-econ my-timeline
{"view":"hashtag-econ","source":"my-timeline","status":"ready"}
```

**Status**: ✅ PASS - Checkpointing and incremental updates work correctly

---

### Test 8: Complex Nested Filter ✅

**Filter**: `(#Econ OR #ACA) AND NOT atrupar.com`

```json
{
  "_tag": "And",
  "left": {
    "_tag": "Or",
    "left": {"_tag":"Hashtag","tag":"#Econ"},
    "right": {"_tag":"Hashtag","tag":"#ACA"}
  },
  "right": {
    "_tag": "Not",
    "expr": {"_tag":"Author","handle":"atrupar.com"}
  }
}
```

**Result**: 2 matched (both with hashtags, neither from atrupar)
**Verification**: Results meet all criteria

```bash
$ bun run index.ts query complex-filter --format json | jq '.[] | {author, hashtags}'
{
  "author": "charlesgaba.com",
  "hashtags": ["#ACA"]
}
{
  "author": "joebrusuelas.bsky.social",
  "hashtags": ["#Econ", "#EconSky"]
}
```

**Status**: ✅ PASS - Complex nested filter logic works correctly

---

### Test 9: Reset with --yes Flag ❌

**Bug**: StoreIndex.clear fails on non-existent checkpoint file

**Reproduction**:
```bash
$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"None"}' --reset --yes
```

**Error**:
```
Exit code: 7
Error type: StoreIndexError
Message: "StoreIndex.clear failed"
Cause: NotFound error when removing checkpoint file
Path: /Users/pooks/.skygent/kv/stores%2Ftest-derived%2Fcheckpoints%2Findexes%2Fprimary
```

**Status**: ❌ FAIL - Filed as bug skygent-bsky-tuy

---

## Additional Validations Performed

### Idempotence ✅
Running derivation twice with same filter produces zero new matches:

```bash
$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"All"}'
{"eventsProcessed":4699,"eventsMatched":4699}

$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"All"}'
{"eventsProcessed":0,"eventsMatched":0}
```

### Filter Change Detection ✅
Attempting to derive with different filter produces clear error:

```bash
$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"None"}'
Error: "Derivation settings have changed since last derivation.
Previous filter hash: {\"_tag\":\"All\"}
New filter hash:      {\"_tag\":\"None\"}

This would result in inconsistent data. Options:
  1. Use --reset --yes to discard existing data and start fresh
  2. Use the same filter expression as before
  3. Derive into a new target store"
```

### Lineage Tracking ✅
Store metadata correctly records derivation lineage:

```bash
$ bun run index.ts store show test-derived | jq .lineage
{
  "storeName": "test-derived",
  "isDerived": true,
  "sources": [{
    "storeName": "my-timeline",
    "filter": {"_tag": "All"},
    "filterHash": "{\"_tag\":\"All\"}",
    "evaluationMode": "EventTime",
    "derivedAt": "2026-01-26T22:42:12.166Z"
  }],
  "updatedAt": "2026-01-26T22:42:12.166Z"
}
```

---

## Performance Observations

| Operation | Events Processed | Duration | Throughput |
|-----------|-----------------|----------|------------|
| All filter (full copy) | 4,699 | 11.6s | 405 events/s |
| Author filter | 4,699 | 1.2s | 3,916 events/s |
| Hashtag filter | 4,699 | 1.1s | 4,272 events/s |
| Regex filter | 4,699 | 1.4s | 3,356 events/s |
| NOT filter (inverse) | 4,699 | 9.6s | 489 events/s |
| Incremental update | 815 | 1.0s | 815 events/s |
| Complex nested filter | 5,514 | 1.7s | 3,243 events/s |

**Observations**:
- Filters that match many results (All, NOT) are slower due to write overhead
- Selective filters (Author, Hashtag) are very fast
- Incremental updates work efficiently with checkpointing

---

## Conclusions

### What Works ✅
1. **Filter Logic**: All filter types (Author, Hashtag, Regex, And, Or, Not) work correctly
2. **Incremental Derivation**: Checkpointing enables efficient incremental updates
3. **Idempotence**: Running derivation multiple times is safe and efficient
4. **Filter Change Detection**: Clear error messages prevent inconsistent data
5. **Lineage Tracking**: Derived store metadata properly tracks source and filter
6. **View Status**: Staleness detection works correctly
7. **Performance**: Processing throughput is acceptable for timeline-scale data

### Known Issues ❌
1. **Bug skygent-bsky-tuy**: StoreIndex.clear fails when checkpoint file doesn't exist during --reset operation

### Recommendations
1. Fix bug skygent-bsky-tuy (Priority 1) to enable full reset workflow
2. Document filter JSON syntax with examples
3. Consider adding `--dry-run` flag to show derivation statistics without writing
4. Add progress reporting for long-running derivations

---

## Test Environment

- **Tool**: skygent-bsky CLI
- **Data Source**: Real Bluesky timeline data
- **Test Date**: 2026-01-26
- **Events Processed**: 5,514 posts
- **Filters Tested**: Author, Hashtag, Regex, And, Or, Not, Complex nested
- **Runtime**: Effect-TS with KeyValueStore backend

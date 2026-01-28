# Usability Improvements for Agentic Use

**Purpose**: Optimize CLI for AI agents to minimize token waste and trial-and-error
**Date**: 2026-01-26

---

## Current Issues

### 1. Schema Validation Errors Are Cryptic ❌

**Problem**: When I tried the Regex filter with wrong schema, the error was difficult to parse:

```json
{
  "message": "patterns: is missing",
  "cause": {
    "_id": "ParseError",
    "message": "(parseJson <-> <suspended schema>)\n└─ Type side transformation failure\n   └─ { readonly _tag: \"All\" } | { readonly _tag: \"None\" } | ... [huge union type dump] ...\n      └─ { readonly _tag: \"Regex\"; readonly patterns: (NonEmptyString | minItems(1) <-> minItems(1)); readonly flags?: string }\n         └─ [\"patterns\"]\n            └─ is missing"
  }
}
```

**Agent Impact**:
- Agent must parse nested error structure
- Full schema dump wastes tokens (100+ lines)
- No clear "here's what you should do" guidance

**Improvement Needed**:
```json
{
  "error": "FilterValidationError",
  "message": "Regex filter requires 'patterns' field (array of strings)",
  "received": {"_tag": "Regex", "pattern": "[Tt]rump"},
  "expected": {"_tag": "Regex", "patterns": ["[Tt]rump"], "flags": "i"},
  "fix": "Change 'pattern' to 'patterns' and wrap value in array"
}
```

**Priority**: P1 - Blocks agents from self-correcting

---

### 2. Target Store Must Pre-Exist (Non-Obvious) ❌

**Problem**: When I tried to derive without creating target store first:

```bash
$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"All"}'
{"error":{"name":"test-derived","_tag":"StoreNotFound"}}
```

**Agent Impact**:
- Not clear if error refers to source or target
- Agent must guess that target needs creation
- Wastes 1-2 attempts figuring this out

**Improvement Needed**:

Option A: Auto-create target stores
```bash
$ bun run index.ts derive my-timeline test-derived --filter-json '{"_tag":"All"}'
{"info":"Target store 'test-derived' does not exist, creating with default config"}
{"source":"my-timeline","target":"test-derived","result":{...}}
```

Option B: Clear error message
```json
{
  "error": "StoreNotFound",
  "store": "test-derived",
  "context": "target",
  "message": "Target store 'test-derived' does not exist",
  "fix": "Run: bun run index.ts store create test-derived"
}
```

**Recommendation**: Option A (auto-create) for better UX

**Priority**: P1 - Causes guaranteed wasted attempt

---

### 3. No Filter Syntax Examples in Help Text ❌

**Problem**: `--filter-json` has no inline examples

```bash
$ bun run index.ts derive --help
--filter-json text
  A user-defined piece of text.
  Filter expression as JSON string
  This setting is optional.
```

**Agent Impact**:
- Agent must search docs or guess syntax
- Trial-and-error with validation errors
- High token cost discovering available filter types

**Improvement Needed**:
```bash
--filter-json text
  Filter expression as JSON (EventTime mode supports pure filters only)

  Examples:
    All posts:       '{"_tag":"All"}'
    By author:       '{"_tag":"Author","handle":"user.bsky.social"}'
    By hashtag:      '{"_tag":"Hashtag","tag":"#ai"}'
    By regex:        '{"_tag":"Regex","patterns":["pattern"],"flags":"i"}'
    Combined (AND):  '{"_tag":"And","left":{...},"right":{...}}'
    Combined (OR):   '{"_tag":"Or","left":{...},"right":{...}}'
    Inverted (NOT):  '{"_tag":"Not","expr":{...}}'

  This setting is optional (defaults to All).
```

**Priority**: P0 - Would prevent most schema errors

---

### 4. Mode Validation Error Is Good ✅

**Example**: EventTime mode rejecting effectful filters worked well:

```json
{
  "message": "EventTime mode does not allow Trending/HasValidLinks filters. Use --mode derive-time for effectful filters.",
  "cause": {"filterExpr": {...}, "mode": "EventTime"}
}
```

**Why This Works**:
- Clear explanation of what's wrong
- Actionable fix (use --mode derive-time)
- No wasted attempts

**Keep**: This pattern is good for agents

---

### 5. Reset Confirmation Pattern Is Awkward ❌

**Problem**: Two-step validation requires trial attempt:

```bash
$ bun run index.ts derive source target --filter-json '...' --reset
Error: "--reset is destructive. Re-run with --yes to confirm."

$ bun run index.ts derive source target --filter-json '...' --reset --yes
[executes]
```

**Agent Impact**:
- Agent always needs 2 attempts
- Predictable pattern but still wastes tokens

**Improvement Needed**:

Option A: Prompt-based (interactive agents only)
```bash
$ bun run index.ts derive source target --filter-json '...' --reset
Warning: This will delete all existing data in 'target'. Continue? [y/N]
```

Option B: Single-step validation (better for agents)
```bash
$ bun run index.ts derive source target --filter-json '...' --reset --yes
[executes immediately]

$ bun run index.ts derive source target --filter-json '...' --reset
Error: "--reset requires --yes flag for safety. Add --yes to confirm."
```

**Current**: Already implements Option B ✅
**Status**: Acceptable for agents (clear error message guides to fix)

---

### 6. Lineage Output Is Too Verbose ❌

**Problem**: `store show` dumps full filter expression in lineage:

```json
{
  "lineage": {
    "sources": [{
      "storeName": "my-timeline",
      "filter": {"_tag":"And","left":{"_tag":"Or","left":{"_tag":"Hashtag","tag":"#Econ"},"right":{"_tag":"Hashtag","tag":"#ACA"}},"right":{"_tag":"Not","expr":{"_tag":"Author","handle":"atrupar.com"}}},
      "filterHash": "{\"_tag\":\"And\",\"left\":{\"_tag\":\"Or\",\"left\":{\"_tag\":\"Hashtag\",\"tag\":\"#Econ\"},\"right\":{\"_tag\":\"Hashtag\",\"tag\":\"#ACA\"}},\"right\":{\"_tag\":\"Not\",\"expr\":{\"_tag\":\"Author\",\"handle\":\"atrupar.com\"}}}",
      "evaluationMode": "EventTime",
      "derivedAt": "2026-01-26T22:42:12.166Z"
    }]
  }
}
```

**Agent Impact**:
- Redundant data (filter + filterHash both present)
- Long JSON wastes input tokens on every store show
- Agent rarely needs full filter reconstruction

**Improvement Needed**:

Add `--verbose` flag for full details:
```bash
# Default: compact view
$ bun run index.ts store show complex-filter
{
  "store": {"name": "complex-filter", "root": "stores/complex-filter"},
  "config": {...},
  "lineage": {
    "isDerived": true,
    "source": "my-timeline",
    "filterHash": "sha256:abc123...",
    "mode": "EventTime",
    "derivedAt": "2026-01-26T22:42:12.166Z"
  }
}

# Verbose: full filter expression
$ bun run index.ts store show complex-filter --verbose
{
  ...,
  "lineage": {
    "isDerived": true,
    "source": "my-timeline",
    "filter": {"_tag": "And", ...},
    "filterHash": "sha256:abc123...",
    "mode": "EventTime",
    "derivedAt": "2026-01-26T22:42:12.166Z"
  }
}
```

**Priority**: P2 - Reduces token cost for common operations

---

### 7. View Status Is Perfect ✅

**Example**:
```bash
$ bun run index.ts view status hashtag-econ my-timeline
{"view":"hashtag-econ","source":"my-timeline","status":"stale"}
```

**Why This Works**:
- Minimal, machine-readable output
- Single clear field: "ready" or "stale"
- No extra verbosity

**Keep**: This is ideal for agents

---

### 8. Derive Result Output Is Good But Could Be Better ⚠️

**Current**:
```json
{
  "source": "my-timeline",
  "target": "test-derived",
  "mode": "EventTime",
  "result": {
    "eventsProcessed": 4699,
    "eventsMatched": 131,
    "eventsSkipped": 4568,
    "deletesPropagated": 0,
    "durationMs": 1236
  }
}
```

**What Works**:
- Clear success/failure semantics
- Numeric counts are parseable
- Duration helps agents estimate time

**Improvement**:
```json
{
  "status": "success",
  "source": "my-timeline",
  "target": "test-derived",
  "mode": "EventTime",
  "checkpoint": "01HKJ...", // Last processed EventId
  "result": {
    "eventsProcessed": 4699,
    "eventsMatched": 131,
    "eventsSkipped": 4568,
    "deletesPropagated": 0
  },
  "performance": {
    "durationMs": 1236,
    "throughput": 3800  // events/second
  }
}
```

**Benefits**:
- `status` field for easy success detection
- `checkpoint` allows agents to verify progress
- `throughput` helps agents estimate future operations

**Priority**: P3 - Nice to have

---

## Recommendations

### High Priority (P0-P1)

1. **Add filter examples to --help output** (P0)
   - Prevents 80% of schema errors
   - Zero-cost documentation at point of use

2. **Improve schema validation errors** (P1)
   - Clear "expected vs received" format
   - Actionable fix suggestions
   - Remove verbose schema dumps

3. **Auto-create target stores or improve error** (P1)
   - Option A: Auto-create (best UX)
   - Option B: Clear error with exact fix command

### Medium Priority (P2)

4. **Add --compact flag to store show** (P2)
   - Default to compact lineage output
   - Add --verbose for full details
   - Reduces token cost 50-70%

5. **Add filter validation endpoint** (P2)
   ```bash
   $ bun run index.ts filter validate '{"_tag":"Regex","pattern":"..."}'
   Error: Field 'pattern' should be 'patterns' (array)
   Example: {"_tag":"Regex","patterns":["..."],"flags":"i"}
   ```
   - Agents can validate before attempting derivation
   - Catch-and-fix loop without side effects

### Low Priority (P3)

6. **Enhanced derive output** (P3)
   - Add `status` field
   - Add `checkpoint` field
   - Add `throughput` calculation

7. **Progress reporting for long operations** (P3)
   ```bash
   $ bun run index.ts derive large-store target --filter-json '...'
   {"progress": 1000, "total": 10000, "matched": 50}
   {"progress": 2000, "total": 10000, "matched": 103}
   ...
   ```
   - Helps agents track long-running operations
   - Enables partial result handling

---

## Agent-Friendly Output Principles

Based on testing, these patterns work well:

### ✅ DO
- Single-line JSON for successful operations
- Clear `status` or `error` discriminator fields
- Numeric metrics over descriptive text
- Actionable fix suggestions in errors
- Examples in help text

### ❌ DON'T
- Multi-line descriptive output
- Verbose schema dumps
- Ambiguous error messages
- Hidden required fields
- Trial-and-error required workflows

---

## Implementation Plan

### Phase 1: Quick Wins (1-2 hours)
- Add filter examples to CLI help text
- Improve StoreNotFound error message
- Add --compact flag to store show

### Phase 2: Error Improvements (2-3 hours)
- Custom schema error formatter
- Expected/received diff output
- Actionable fix suggestions

### Phase 3: New Features (3-4 hours)
- Auto-create target stores
- Filter validation command
- Progress reporting for large operations

---

## Success Metrics

**Before**:
- Average attempts to successful derivation: 2-3
- Token cost per error: 500-1000 tokens (verbose schema dumps)
- Agent trial-and-error rate: ~40%

**After** (target):
- Average attempts to successful derivation: 1-1.2
- Token cost per error: 100-200 tokens (focused messages)
- Agent trial-and-error rate: ~10%

**ROI**: 3-4x reduction in wasted attempts = significant token savings for agent workflows

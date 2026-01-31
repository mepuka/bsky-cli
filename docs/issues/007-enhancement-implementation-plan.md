# Enhancement Implementation Plan

**Date:** 2026-01-31
**Scope:** Remaining enhancement issues (#99, #97, #96, #95, #93, #88, #68)

---

## Decisions Locked In

- **Default output format:** Compact is the preferred "gold" default for agent-facing CLI outputs.
- **`skygent pipe` input:** Accept **raw post NDJSON** (raw Bluesky post objects) to keep parsing consistent and robust.
- **Open questions resolved (93 + 99):**
  - **Store rename (#93):** Update catalog, store filesystem root, derivation checkpoints, and lineage records. **Do not rewrite historical event log provenance by default** (expensive); provide an optional `--rewrite-provenance` for full migration.
  - **Multi-store query (#99):** Treat `--scan-limit` as **per-store** to preserve current semantics and predictability; apply `--limit` **globally** after merge. For output, include `store` on JSON/NDJSON results and **reject non-JSON formats** unless `--format` explicitly supports multi-store (table/thread will warn + require `--format json|ndjson|compact`).

---

## Effect Source References (Citations)

These items are used to justify API choices and deterministic stream behavior:

- `Stream.combine` for deterministic ordered merge of two streams (k-way merge can be layered). Source: `node_modules/effect/dist/esm/Stream.js` and `node_modules/effect/dist/dts/Stream.d.ts` (combine signature + pull semantics).
- `Stream.mergeAll` for non-deterministic parallel merge (explicitly **not** suitable for ordered multi-store). Source: `node_modules/effect/dist/esm/Stream.js` and `node_modules/effect/dist/dts/Stream.d.ts` (mergeAll concurrency/buffer behavior).
- `Stream.interleave` for deterministic alternating pull (useful for fairness in global scan limit strategies if needed). Source: `node_modules/effect/dist/esm/Stream.js` and `node_modules/effect/dist/dts/Stream.d.ts`.
- `Stream.merge` for two-stream non-deterministic merge (documented to end when both terminate). Source: `node_modules/effect/dist/esm/Stream.js` and `node_modules/effect/dist/dts/Stream.d.ts`.

---

## Phase 0 - UX Quick Wins (Low Risk, High Value)

### #68 Filter DSL discoverability
**Goal:** Make predicates discoverable and reduce parse frustration.

**Implementation details**
- Add `skygent filter help` subcommand that prints DSL examples from `src/cli/filter-help.ts`.
- Append parse error hint: "Tip: run `skygent filter help` for all predicates."

**Files**
- `src/cli/filter.ts` (add `help` command)
- `src/cli/filter-help.ts` (expand DSL examples if needed)
- `src/cli/filter-dsl.ts` (append help hint on unknown predicates)
- Docs: `README.md`, `docs/filters/README.md`

**Tests**
- CLI integration: `skygent filter help` outputs examples, stdout only.

**Risk**: Very low.

---

### #95 Graph relationships output enrichment
**Goal:** Show actor input + handle/DID context; improve table output.

**Implementation details**
- Table: add `ACTOR` column to show original input (handle or DID), not just DID.
- JSON: wrap output to include `{ actorInput, actorDid, relationships }` in order.
- Keep existing raw output via `--raw` flag (backward compatibility).

**Files**
- `src/cli/graph.ts` (rendering + output shape)
- `src/services/identity-resolver.ts` (if adding handle resolution)

**Tests**
- CLI output: table columns, JSON wrapper ordering.

**Risk**: Low.

---

### #88 Compact as default output format
**Goal:** Make `compact` the default for query-like commands.

**Implementation details**
- Change query fallback to `compact` when no config override is set.
- Keep global default `ndjson` for stream commands (`watch`, `sync`, `pipe`).
- Update docs and CLI help.

**Files**
- `src/cli/query.ts`
- `src/services/app-config.ts` (if making global)
- `src/cli/config.ts` (if exposing as config)
- `docs/outputs.md`, `README.md`

**Tests**
- Query output default snapshot tests.

**Risk**: Low-medium (behavioral change).

---

## Phase 1 - Safe Data Ops + Pipeline

### #93 Store rename command
**Goal:** Support `skygent store rename old new` safely.

**Chosen resolution:**
- **Update**: catalog row, store root path, derivation checkpoints (source + target), lineage KV.
- **Optional**: `--rewrite-provenance` updates `event_log` JSON payloads containing `sourceStore`.

**Implementation details**
1) Validate: new name passes `StoreName` schema, old exists, new does not.
2) Rename filesystem: `storeRoot/stores/<old>` -> `storeRoot/stores/<new>`.
3) Update catalog transaction (`catalog.sqlite`): `name`, `root`, `updated_at`.
4) Update derivation checkpoints across stores (`index.sqlite`):
   - `target_store` updates inside renamed store.
   - `source_store` updates across all stores.
5) Update lineage KV (`stores/<name>/lineage` + sources list).
6) Optional `--rewrite-provenance`: update `event_log` payload JSON.

**Files**
- `src/services/store-manager.ts` (new `renameStore` API)
- `src/services/store-db.ts` (client teardown for old name)
- `src/services/view-checkpoint-store.ts`
- `src/services/lineage-store.ts`
- `src/cli/store.ts` (new `rename` subcommand)

**Tests**
- Rename integration test: store exists after rename, old missing, derived checkpoints consistent.
- Lineage test: `store tree` still resolves sources.

**Risk**: Medium (data integrity). Requires transactional updates and careful error handling.

---

### #97 `skygent pipe` stdin/stdout pipeline
**Goal:** Stream NDJSON raw posts from stdin, apply filters, output matching posts to stdout.

**Chosen resolution:**
- Input is **raw post NDJSON** (same schema as `app.bsky.feed.getPosts`).

**Implementation details**
- Add `CliInput` service (stdin stream) similar to `CliOutput`.
- Pipeline:
  1) stdin -> `Stream.decodeText` -> `Stream.splitLines` -> trim/skip blanks
  2) `decodeJson(RawPost)` -> `PostParser.parsePost`
  3) `FilterRuntime.evaluateBatch` on `Stream.grouped(n)`
  4) `CliOutput.writeJsonStream` (NDJSON output)
- Add `--on-error=fail|skip|report` (default `fail`).

**Files**
- `src/cli/pipe.ts` (new command)
- `src/cli/layers.ts` (provide `CliInput.layer`)
- `src/cli/app.ts` (register subcommand)
- `src/cli/output.ts` (reuse `writeJsonStream`)

**Tests**
- Stream parse (valid raw input)
- Error handling: malformed JSON line, invalid schema
- Ordering preserved through batching

**Risk**: Medium (stream parsing, backpressure).

---

## Phase 2 - Multi-Store Query (Higher Complexity)

### #99 Multi-store query
**Goal:** Query across multiple stores with ordered output.

**Chosen resolution:**
- `--scan-limit` is **per-store**; `--limit` is global after merge.
- Output includes `store` on JSON/NDJSON; non-JSON formats are rejected for multi-store unless explicitly supported.

**Implementation details**
- CLI: allow `store` arg list (`store1,store2`) and/or repeat `--store`.
- For each store: `StoreIndex.query(store, StoreQuery)`.
- Apply any non-pushdown filtering per store (`FilterRuntime`) before merge.
- Merge streams deterministically using `Stream.combine` and a k-way heap by `(createdAt, uri)`.
  - `Stream.mergeAll` is **not** deterministic and is intentionally avoided.
- Optional `--dedupe` by `PostUri` to collapse duplicates across stores.

**Files**
- `src/cli/query.ts` (multi-store resolution + output)
- `src/services/store-index.ts` (no change; reuse)
- `src/cli/output-format.ts` (format restrictions for multi-store)

**Tests**
- Ordering with tie-breakers across stores
- `limit` applied globally
- `scan-limit` applied per store
- Dedupe correctness

**Risk**: Medium-high (ordering + perf).

---

## Phase 3 - Digest Command (Broader Scope)

### #96 Digest command
**Goal:** Summarize a store (top posts, hashtags, authors, volume) for agent briefings.

**Implementation details (MVP)**
- Query store with `--since` range, aggregate:
  - top posts by engagement
  - top hashtags
  - new authors
  - post volume over time
- Render to markdown + json.

**Files**
- `src/cli/digest.ts` (new)
- `src/cli/app.ts`
- `src/domain/format.ts` (if new renderers needed)

**Tests**
- Snapshot/fixture tests for digest output

**Risk**: Medium-high (new aggregation logic).

---

## Next Actions (Recommended)

1) Implement Phase 0 (quick wins) in one PR.
2) Implement Phase 1 (rename + pipe) as two separate PRs for clean review.
3) Multi-store query as a focused PR with ordering tests.

---

## Notes on Effect-Native Patterns

- Use `Effect.gen` + `Effect.fn` for naming and instrumentation.
- Use `Context.Tag` + `Layer` to add new CLI services (e.g., `CliInput`).
- For stream merges, use `Stream.combine` for deterministic ordered merging; avoid `Stream.mergeAll` where ordering matters. (See Effect sources cited above.)


# Production Readiness Remediation Plan (Stream + Concurrency)

Date: 2026-01-30
Scope: Stream/Effect concurrency risks and production hardening

## Goals

- Eliminate OOM risks in materialization flows.
- Make concurrency predictable and tunable for filter evaluation.
- Remove implicit ordering dependence in cursor updates (or document it).

## Findings (source of truth)

1) `store materialize` collects all filtered posts into memory before writing outputs.
   - Risk: OOM or long stalls on large stores.
   - Location: `src/services/output-manager.ts`

2) Filter evaluation uses unbounded concurrency within batches.
   - Risk: bursty IO and saturation when filters hit network (e.g., link validation).
   - Locations: `src/services/filter-runtime.ts`, `src/typeclass/chunk.ts`, `src/services/output-manager.ts`

3) Sync cursor updates rely on ordered stream processing.
   - Current Effect Stream `mapEffect` preserves order unless `unordered: true`.
   - Risk: future refactors may unknowingly break ordering assumptions.
   - Locations: `src/services/sync-engine.ts`

## Remediation Plan

### A) Stream materialized outputs (blocker)

**Plan**
- Replace `Stream.runCollect` in `materializeFilter` with streaming writes.
- Use `FileSystem.sink` to write `posts.json` and `posts.md` incrementally.
- Track post count during streaming and write `manifest.json` after completion.

**Proposed implementation sketch**
- JSON
  - Write `[` once.
  - Stream each post as `JSON.stringify(post)` with comma separators.
  - Close with `]\n` after the stream completes.
- Markdown
  - Write header + separator once.
  - Stream each post row as a line.
- Count posts via a `Ref` or fold in the stream.

**Acceptance**
- Materialization completes in constant memory.
- Identical output format as current implementation.
- Large stores no longer OOM.

### B) Bound filter evaluation concurrency (blocker)

**Plan**
- Introduce `SKYGENT_FILTER_CONCURRENCY` (default 10-20).
- Apply in:
  - `FilterRuntime.evaluateBatch` (replace `concurrency: "unbounded"`).
  - `OutputManager.materializeFilter` when calling `traverseFilterEffect`.
- Optional: share a central config service for filter concurrency.

**Acceptance**
- Concurrency is tunable and bounded.
- No unbounded task fan-out on network-backed filters.

### C) Cursor ordering hardening (recommended)

**Plan (choose one)**
1) Keep ordered processing but document that ordering is required.
2) Make cursor updates independent of ordering:
   - Track max cursor per page (not per post), or
   - Update cursor only after each page finishes (cursor belongs to the page).

**Acceptance**
- Cursor advances monotonically even if stream becomes unordered.
- No regressions in checkpoint behavior.

## Proposed Changes (files)

- `src/services/output-manager.ts`
  - Stream outputs using `FileSystem.sink`.
  - Remove `Stream.runCollect` and in-memory arrays.

- `src/services/filter-runtime.ts`
  - Use bounded concurrency in `evaluateBatch`.

- `src/typeclass/chunk.ts`
  - Ensure `traverseFilterEffect` uses bounded concurrency.

- `src/services/sync-engine.ts`
  - Add ordering comment or implement max-cursor tracking.

- `src/services/app-config.ts` and/or new settings service
  - Add `SKYGENT_FILTER_CONCURRENCY`.

## Rollout Plan

1) Implement streaming materialization + bounded concurrency.
2) Add tests:
   - Materialize large store (size regression test or integration).
   - Ensure materialized outputs are unchanged for small fixtures.
3) Decide cursor hardening approach and implement.
4) Run `bun test` and `bun run typecheck`.

## Risks / Mitigations

- Streaming output must preserve formatting:
  - Add golden tests for JSON + Markdown materialize.
- Bounded concurrency might slow very small workloads:
  - Provide config override and conservative default.


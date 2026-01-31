# Refactor Plan: Reduce Duplication + Effect-Native Ordering/Equivalence

**Date:** 2026-01-31  
**Scope:** Reduce CLI duplication and centralize ordering/equality semantics using Effect Order/Equivalence.  
**Motivation:** Multiple ad-hoc sort/comparator implementations risk drift between SQL, CLI, rendering, and tests.

---

## Goals

1) Centralize ordering rules (posts, store-posts, checkpoints) with Effect `Order`.  
2) Reduce CLI option/parsing duplication (pagination, thread depth, format routing).  
3) Consolidate table renderers and parse error utilities.  
4) Improve robustness by making ordering/equality semantics explicit and reusable.

Non-goals:
- No behavioral changes to query/sync semantics beyond ordering consistency.
- No new features or schema changes.

---

## Phase 0 — Baseline Audit (low risk)

**Deliverables**
- Inventory of ordering/comparator hotspots and duplicated CLI helpers (done; see phases below).

**Acceptance**
- Plan reviewed and approved for implementation.

---

## Phase 1 — Shared Ordering Module (medium risk, high value)

**Focus**: Centralize ordering into a new module and update highest-risk call sites.

**Implementation**
- Add `src/domain/order.ts` (or `src/domain/ordering.ts`) exporting:
  - `PostOrder` — `createdAt` then `uri` (matches `StoreIndex.query` SQL order).
  - `StorePostOrder` — `createdAt`, `uri`, `store` (multi-store merge tie-breaks).
  - `CheckpointOrder` — `updatedAt` (latest checkpoint selection).
- Update call sites to use `Order` rather than ad-hoc `sort`:
  - `src/cli/query.ts` (multi-store merge order).
  - `src/cli/doc/thread.ts` (post ordering in thread render).
  - `src/services/store-stats.ts` (latest checkpoint selection).
  - `src/cli/store-tree.ts` (latest checkpoint selection).
  - `tests/services/store-index.property.test.ts` (ordering in tests).

**Acceptance**
- All ordering uses shared `Order` definitions.
- No change in runtime behavior beyond consistent tie-break rules.
- Tests pass.

---

## Phase 2 — Make Stream Merge Order-Aware (medium risk)

**Focus**: Use Effect `Order` at the merge boundary.

**Implementation**
- Update `src/cli/stream-merge.ts` to accept `Order.Order<A>` instead of `(a, b) => number`.
- Optionally accept `Equivalence.Equivalence<A>` for tie-handling or future de-duplication.
- Update `src/cli/query.ts` to pass `StorePostOrder` directly.

**Acceptance**
- Merge helper uses Effect `Order`.
- Call sites updated without behavioral changes.

---

## Phase 3 — CLI Duplication Cleanup (medium risk)

**Focus**: Reduce repeated option parsing and format routing.

**Implementation**
- Pagination helpers:
  - Create `src/cli/pagination.ts` (or expand `src/cli/shared-options.ts`) with
    `limitOption`, `cursorOption`, and `parsePagination`.
  - Use in `src/cli/search.ts`, `src/cli/feed.ts`, `src/cli/post.ts`, `src/cli/graph.ts`.
- Thread depth helpers:
  - Create `src/cli/thread-options.ts` with `depthOption`, `parentHeightOption`, `parseThreadDepth`.
  - Use in `src/cli/sync.ts`, `src/cli/watch.ts`, `src/cli/view-thread.ts`.
- Output format routing:
  - Add `src/cli/output-render.ts` with `emitWithFormat(...)` to standardize JSON/NDJSON/table/markdown branching.
  - Use in `src/cli/search.ts`, `src/cli/feed.ts`, `src/cli/post.ts`, `src/cli/graph.ts`, `src/cli/query.ts`.

**Acceptance**
- Shared helpers used in at least 4 CLI modules.
- Reduced duplicated parsing logic.
- No change in CLI behavior.

---

## Phase 4 — Renderer & Parse Utilities Consolidation (low risk)

**Focus**: Unify table renderers and parse error helpers.

**Implementation**
- Extract shared table renderers:
  - `renderProfileTable`, `renderFeedTable` into `src/cli/doc/table-renderers.ts`.
  - Update `src/cli/graph.ts`, `src/cli/search.ts`, `src/cli/post.ts`, `src/cli/feed.ts`.
- Consolidate parse error utilities:
  - Move `safeParseJson`, `issueDetails`, and formatting helpers into `src/cli/parse-errors.ts`.
  - Use from `src/cli/parse.ts`, `src/cli/filter-errors.ts`, `src/cli/store-errors.ts`.

**Acceptance**
- Renderer helpers used across modules.
- Parse error formatting consistent and centralized.

---

## Optional Phase 5 — Equivalence Helpers (low risk)

**Focus**: Make equality semantics explicit where string signatures are used only for equality/dedupe.

**Implementation**
- Add `Equivalence<DataSource>` and/or `Equivalence<FilterExpr>` in `src/domain/*` as needed.
- Keep string keys only where persistence or stable IDs are required.

**Acceptance**
- Equality checks are explicit and consistent across modules.

---

## Risks / Mitigations

- **Risk**: Subtle ordering changes.  
  **Mitigation**: Use shared `Order` definitions mirroring SQL ordering and add tests for tie-breaks.

- **Risk**: CLI behavioral drift from refactors.  
  **Mitigation**: Keep acceptance tests and compare output snapshots for key commands.

---

## Suggested Implementation Order

1) Phase 1 (Ordering module + high-value call sites).  
2) Phase 2 (Order-aware stream merge).  
3) Phase 3 (CLI duplication cleanup).  
4) Phase 4 (Renderers + parse errors).  
5) Phase 5 (Equivalence helpers, as needed).

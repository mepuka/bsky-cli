# Effect + Printer Remediation Spec (UX-Forward)

**Date:** 2026-01-29  
**Scope:** Issues identified in the 2026-01-29 review (Effect services + printer)  
**Goal:** Provide a mediation plan, UX recommendations, and a phased implementation spec.

---

## Executive Summary

We will resolve six issues across sync reliability, concurrency safety, and printer polish. The plan is phased to minimize user disruption while improving correctness and deterministic behavior. UX defaults remain stable, with opt-in flags for behavior changes, plus clearer messages and safe locking semantics.

---

## Issues Summary

| ID | Severity | Issue | Affected Areas | Resolution Summary |
|---|---|---|---|---|
| R1 | High | Sync checkpoint not saved when zero posts match (cursor ignored) | `src/services/sync-engine.ts` | Save checkpoint when a cursor is present, even if `lastEventId` is empty |
| R2 | High | Derive runs without store lock (race with sync/watch) | `src/cli/derive.ts` | Acquire store lock(s) for derive with clear UX messaging |
| R3 | Medium | ULID generation non-atomic across concurrent calls | `src/services/store-writer.ts` | Use `SynchronizedRef.modifyEffect` or a semaphore for atomic ID generation |
| R4 | Medium | Sync dedupe policy hides updates/metrics changes | Sync CLI + engine | Add explicit upsert policy + UX flags; keep default unchanged |
| R5 | Low | Output manager uses `new Date()` (not `Clock`) | `src/services/output-manager.ts` | Use `Clock` for determinism and testing |
| R6 | Low | Printer connector styling inconsistent | `src/cli/doc/tree.ts` | Annotate connectors consistently |

---

## Mediation Plan (User-First Resolution Strategy)

1. **Stability over surprise**  
   Keep current behavior as defaults; introduce new behavior behind explicit flags (e.g., refresh/upsert policy).

2. **Clear recovery and next-step guidance**  
   All new user-facing errors should include a single recommended action, not just a failure reason.

3. **Predictable locking**  
   Locks fail fast by default with a clear error; optionally allow waiting via an explicit flag.

4. **Deterministic output**  
   Use `Clock` to improve testability and reproducibility, especially in output manifests and sync flows.

5. **Small, testable steps**  
   Each phase includes tests and acceptance criteria to avoid regressions.

---

## UX Recommendations by Issue

### R1: Checkpoint saved even with zero matched posts
- **UX behavior:** After a run with zero matches, emit a checkpoint line:
  - `Checkpoint saved (cursor=..., lastEventId=none)`
- **Reason:** Users expect sync to advance even when filters are selective.

### R2: Store locks for derive
- **UX behavior:** On lock failure, show:
  - `Store "X" is busy. Try again or pass --wait 30s to wait for lock.`
- **Optional UX flag:** `--wait <duration>` to retry lock acquisition with a timeout.
- **Default:** fail fast (no waiting) to avoid hanging in scripts.

### R3: ULID generation atomicity
- **UX impact:** none (internal).
- **Dev notes:** Avoid duplicate IDs under concurrent sync/watch.

### R4: Sync upsert policy / refresh mode
- **Default:** keep dedupe behavior (no updates to existing posts).
- **Opt-in flag:** `--refresh` (or `--upsert`) for timeline/feed/author/notifications/thread.
- **UX warning:** When `--refresh` is used, emit:
  - `Refresh mode updates existing posts and may grow the event log.`
- **Store-level config:** If set in store config, print:
  - `Using store policy: refresh`

### R5: Output manager timestamps
- **UX impact:** none.
- **Benefit:** consistent testing and determinism.

### R6: Printer connector styling
- **UX behavior:** ANSI colors consistently dim tree connectors, improving readability.

---

## Effect Sources / Abstractions to Use

Consulted Effect guidance: `services-and-layers`, `error-handling`, `cli`, `testing`.

Primary abstractions:
- **Synchronized refs:** `SynchronizedRef.make`, `SynchronizedRef.modifyEffect`  
  `node_modules/effect/src/SynchronizedRef.ts`
- **Semaphores (alternative to SynchronizedRef):** `Effect.makeSemaphore`  
  `node_modules/effect/src/Effect.ts`
- **Scoped resources and locking:** `Effect.acquireRelease`, `Effect.scoped`  
  used in `src/services/store-lock.ts`
- **Checkpoint finalizers:** `Effect.ensuring` / `Stream.ensuring`  
  used in `src/services/sync-engine.ts` and `src/services/jetstream-sync.ts`

---

## Phased Implementation Plan

### Phase 0 — Decisions & UX (pre-work)
**Goal:** Resolve open behavior questions before code changes.

1. **Decide upsert policy defaults**
   - Default remains **dedupe** (current behavior).
   - Add explicit `--refresh` flag for updates.
2. **Decide lock scope for derive**
   - Minimum: lock target store.
   - Recommended: lock target and source to avoid drift during derive.
3. **Pick lock waiting UX**
   - Suggest `--wait <duration>` (optional).

**Exit criteria:** Approved UX behaviors and CLI flags.

---

### Phase 1 — Correctness & Concurrency Safety

#### R1: Sync checkpoint when zero matches
**Files:** `src/services/sync-engine.ts`, `tests/services/sync-engine.test.ts`  
**Plan:**
- In `saveCheckpoint`, allow save when `latestCursor` is set even if `lastEventId` is empty.
- Update tests to cover “filter matches none but cursor advances.”

**Acceptance:**  
Checkpoint saved with cursor even when no posts are stored.

#### R2: Store lock for derive
**Files:** `src/cli/derive.ts`, `src/services/store-lock.ts` (optional helper), tests  
**Plan:**
- Use `StoreLock.withStoreLock` around derive execution.
- If locking both source and target, acquire in sorted order to avoid deadlocks.
- Add optional `--wait <duration>` or `--wait` boolean for lock retry.

**Acceptance:**  
Derive never runs concurrently with sync/watch for the locked stores.

#### R3: Atomic ULID generation
**Files:** `src/services/store-writer.ts`, `tests/services/store-writer.test.ts`  
**Plan:**
- Replace `Ref` with `SynchronizedRef`.
- Use `SynchronizedRef.modifyEffect` to compute ID + update state atomically.
- Add a concurrency test that forks N generators and asserts uniqueness.

**Acceptance:**  
No duplicate `event_id` under concurrent calls.

---

### Phase 2 — Data Freshness (Sync Upsert Policy)

#### R4: Upsert policy for sync
**Files:**  
`src/services/sync-engine.ts`, `src/cli/sync.ts`, `src/domain/store.ts`, docs, tests

**Plan:**
1. Add `SyncUpsertPolicy` to store config:
   - `dedupe` (default)  
   - `refresh` (always upsert)
2. CLI flag `--refresh` (or `--upsert`) to override config for a run.
3. SyncEngine chooses between `appendUpsertIfMissing` (dedupe) and `appendUpsert` (refresh).
4. Document tradeoffs in CLI help and docs.

**Acceptance:**  
User can explicitly refresh existing posts without changing defaults.

---

### Phase 3 — Determinism & Presentation

#### R5: Use Clock in OutputManager
**Files:** `src/services/output-manager.ts`, tests  
**Plan:**
- Replace `new Date()` with `Clock.currentTimeMillis`.
- Use `Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())`.

**Acceptance:**  
Manifest timestamps are TestClock-friendly.

#### R6: Printer connector annotations
**Files:** `src/cli/doc/tree.ts`, `tests/cli/doc/tree.test.ts`  
**Plan:**
- Apply `connector(...)` annotation to all connector segments, including root lines.

**Acceptance:**  
ANSI output styles connectors consistently.

---

## Tests & Verification

| Area | Tests |
|---|---|
| R1 | `sync-engine` test: cursor saved when no posts stored |
| R2 | CLI derive test for lock conflicts; optional wait timeout |
| R3 | Concurrency test for `StoreWriter` ULIDs |
| R4 | Sync policy tests: dedupe vs refresh behaviors |
| R5 | Output manager uses TestClock |
| R6 | Printer snapshot/expectations updated for ANSI connectors |

Manual checks:
- `skygent sync timeline --filter 'hashtag:#never'` saves checkpoint cursor.
- `skygent derive ...` while sync is running returns clear lock error.
- `skygent sync --refresh` logs explicit warning about event log growth.

---

## Open Questions

1. Should derive lock **source** as well as target by default?
2. Should `--refresh` update be the CLI term, or `--upsert`?
3. Do we need a new output field for updated post counts, or is a log line enough?

---

## Rollout Notes

- **Backwards compatible:** Defaults do not change.
- **Docs:** Add a short section in `docs/configuration.md` and CLI help for refresh policy + lock waiting.
- **Migration:** No schema changes required; only config and behavior toggles.


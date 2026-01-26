# Skygent-Bsky: Implementation Plan (Phase-Based)

**Date:** 2026-01-25  
**Status:** Active  
**Goal:** Create an incremental, trackable implementation roadmap aligned to the architecture doc.

---

## 0. Scope and Principles

**In scope**
- Effect-first CLI tool for monitoring and storing Bluesky data.
- Filter system as typed ADT + runtime interpreter.
- Append-only storage log + rebuildable index/views.
- Agent-first CLI outputs (JSON default).

**Out of scope (for MVP)**
- Feed hosting / algorithmic feeds.
- Multi-user support.
- Web UI.
- Full analytics suite.

**Principles**
- Typed errors everywhere (`Schema.TaggedError`).
- Clear raw → parsed domain boundary.
- Config is JSON-first, internal types derived by decoding.
- Bun-first runtime and platform layers.

---

## 1. Phases Overview

### Phase 0 — Project Setup
**Deliverables**
- Minimal folder structure under `src/`.
- Effect/Bun platform wiring in a `main.ts`.
- Logging/telemetry defaults.

**Checklist**
- [ ] Create `src/domain/`, `src/services/`, `src/storage/`, `src/cli/`.
- [ ] Add bun runtime wiring (Bun platform layers).
- [ ] Add base `Config` loader (JSON parse + schema decode).

---

### Phase 1 — Domain Foundation
**Deliverables**
- Branded primitives + domain classes.
- Filter ADT and error/policy types.
- Event and query models.

**Checklist**
- [x] `Post`, `Handle`, `Hashtag`, `PostUri`, `PostCid`, `Timestamp`.
- [x] `FilterExpr` ADT + combinators.
- [x] `FilterErrorPolicy`, `FilterCompileError`, `FilterEvalError`.
- [x] `StoreName`, `StorePath`, `StoreRef`.
- [x] `PostEvent` + `EventMeta`, `StoreQuery`.

**Acceptance**
- All domain types are `Schema.Class`/`Schema.TaggedClass` or branded primitives.
- Compile-time type errors for invalid IDs and handles.

---

### Phase 2 — Ingestion + Parsing
**Deliverables**
- Raw payload types.
- Parser service with `RawPost → Post`.

**Checklist**
- [x] `RawPost` schema and `PostFromRaw` transform.
- [x] `PostParser` service + layer.
- [x] `BskyClient` service with timeline/feed/notifications + auth.

**Acceptance**
- Single decoding boundary for external input.
- Parsing errors are typed and surfaced.

---

### Phase 3 — Filter Compiler + Runtime
**Deliverables**
- `FilterCompiler` (spec → AST).
- `FilterRuntime` (AST → predicate).

**Checklist**
- [x] `FilterSpec` schema (JSON-first).
- [x] `FilterCompiler` with validation + errors.
- [x] Short-circuit `FilterRuntime` with policy handling.
- [x] Optional batched runtime for LLM nodes.
- [x] Regex filter with single or array patterns.
- [x] Effectful filters: `HasValidLinks` + `Trending` (cached HTTP + topics).

**Acceptance**
- Filter evaluation is policy-aware and short-circuiting.
- Filters serialize/deserialize via `Schema`.

---

### Phase 4 — Storage: Event Log + Index
**Deliverables**
- Append-only KV event log (file-based `KeyValueStore`).
- Index/storage interface with rebuild.
- Query-friendly read models (by-uri, by-date, by-hashtag).

**Checklist**
- [x] `StoreWriter.append` (KV entry per event, ULID key) with typed errors.
- [x] `PostEventRecord` envelope (id + version + event) schema.
- [x] Event manifest key (`events/manifest`) to enable ordered replay without directory scans.
- [x] `StoreIndex` backed by file-based `KeyValueStore` (SQLite optional later).
- [x] `StoreManager` for store metadata + config.
- [x] Index rebuild + checkpoint schema (incremental rebuild support).
- [x] Read model for post lookup by URI (query support).

**Acceptance**
- Event log is the source of truth.
- Index can be rebuilt from log.

---

### Phase 5 — Sync Pipeline
**Deliverables**
- End-to-end pipeline from Bsky → parser → filter → store.

**Checklist**
- [x] `SyncEngine.sync` implementation.
- [x] Minimal `SyncResult` + `SyncError`.
- [x] CLI command to run a sync.
- [x] Sync checkpoint + resume (cursor, last event id, filter hash).
- [x] Dedupe by `PostUri` before write.
- [x] Progress reporting to stderr.

**Acceptance**
- Running sync writes events and index entries.
- Errors are typed and logged to stderr.

---

### Phase 6 — CLI
**Deliverables**
- Store, sync, query commands.
- JSON-first output policy.
- Formalized stdout/stderr handling via CLI output service.

**Checklist**
- [x] `store create/list/show` with JSON output.
- [x] `store delete` is idempotent.
- [x] `sync timeline` and `sync feed` with filter expressions.
- [x] `sync notifications`.
- [x] `query` supports time ranges + filter expr.
- [x] `watch` streaming command(s) (NDJSON to stdout).
- [x] OutputFormat ADT (`json|ndjson|markdown|table`) and `--format`.
- [x] Structured error output to stderr + semantic exit codes.
- [x] `--quiet` to suppress progress logs.
- [x] Config hierarchy (CLI > env > file > defaults).
- [x] `CliOutput` service with Bun stdout/stderr sinks for all CLI output/logging.
- [x] Streaming NDJSON uses `Stream.run` + sinks; stdout stays data-only.

**Acceptance**
- Default output is JSON; logs go to stderr.
- Stdout is pure NDJSON for streaming commands.

---

### Phase 7 — Security & Operational Hardening (Pre-Jetstream)
**Deliverables**
- Secure credential handling + redaction.
- Bsky rate limiting + exponential backoff.
- Basic resource monitoring + guardrails.
- Configuration docs for onboarding.

**Checklist**
- [x] Replace plaintext password handling with `Redacted` (Config + CLI).
- [x] Add `CredentialStore` service (env + file store; keychain as optional future backend).
- [x] Remove password from config file persistence (store only identifier).
- [x] Use `@effect/cli` redacted option for secrets; avoid printing in logs.
- [x] Add rate limiting + backoff in `BskyClient` (`Schedule` + jitter).
- [x] Add `.env.example` documenting required env vars.
- [x] Add resource monitoring (store size + memory usage) with warning thresholds.
- [x] Add security notes to README (credential handling + safe usage).

**Acceptance**
- No plaintext password ever written to disk or logs.
- API calls are rate-limited with backoff on 429/5xx.

---

### Phase 8 — Jetstream (Optional)
**Deliverables**
- Jetstream data source wired to pipeline.

**Checklist**
- [ ] Integrate `effect-jetstream` as `DataSource`.
- [ ] Map events into `RawPost`/`PostEvent` with backpressure.
- [ ] Add CLI flag to select Jetstream vs timeline/feed.
- [ ] Document required Jetstream env/config.

**Acceptance**
- Jetstream can feed the same pipeline as timeline.

---

### Phase 9 — LLM Integration & Caching
**Deliverables**
- LLM filter runtime + caching + provenance.

**Checklist**
- [x] Provider selection & fallback via `ExecutionPlan` (env-driven).
- [x] Request batching via `RequestResolver` + `batchN`.
- [x] In-memory request cache (`Request.makeCache`) with TTL.
- [x] Fail-open/closed policy enforcement in filter runtime.
- [x] Persistent LLM cache keyed by model/prompt/content hash.
- [x] LLM annotations stored in event metadata (provenance + confidence).
- [ ] Configuration schema for provider-specific model defaults.
- [ ] Provider health/fallback telemetry (stderr summary + counters).

**Acceptance**
- LLM usage is deterministic and traceable.

---

### Phase 10 — Testing + Hardening
**Deliverables**
- Property-based tests for filter laws.
- Layer swapping tests for services.

**Checklist**
- [x] Filter associativity & identity laws.
- [ ] Store log + rebuild tests.
- [x] CLI integration smoke tests (stdout NDJSON, stderr logs, exit codes).
- [ ] End-to-end sync test with mocked Bluesky responses.
- [ ] Documented local dev checklist (env, config, sample filters).

**Acceptance**
- Tests run via `bun test` and pass locally.

---

## 2. Progress Tracking

Use this table as the single source of truth during implementation:

| Phase | Status | Notes |
| --- | --- | --- |
| 0 | Complete | Bun runtime wiring + base config loader |
| 1 | Complete | Domain primitives, filters, store config, errors added |
| 2 | Complete | RawPost + PostFromRaw + PostParser + BskyClient implemented |
| 3 | Complete | Compiler/runtime + regex + effectful filters complete |
| 4 | Complete | Store log + index + store manager + rebuild complete |
| 5 | Complete | SyncEngine + sync commands + checkpoints/dedupe done |
| 6 | Complete | Store + sync + query + watch + output format/config done |
| 7 | Complete | Credentials + rate limiting + docs + monitoring done |
| 8 | Not started | Jetstream (optional) |
| 9 | In progress | LLM cache + metadata done; model defaults/telemetry pending |
| 10 | In progress | Property tests done; CLI smoke tests pending |

---

## 3. Decision Log (Current)

- Filters are data (`FilterExpr` ADT) and compiled/evaluated by services.
- Persistence uses file-based `KeyValueStore` for event log + rebuildable index (SQLite optional later).
- CLI defaults to NDJSON output; logs to stderr.
- Jetstream integration is optional.
- LLM providers are explicit and ordered via `SKYGENT_LLM_PROVIDERS`; no implicit default.
- LLM fallback/retries are handled via `ExecutionPlan` with per-step attempts/schedule.

---

## 4. Open Questions

**Resolved**
- Retention: keep append-only event log as source of truth; derived views rebuildable. Pruning is a future opt-in tool.
- LLM provider default: none. Require explicit env config; allow ordered fallback via `SKYGENT_LLM_PROVIDERS`.

**Still Open**
- Index scale limits: define a trigger (e.g. >1M events or slow queries) to add SQLite-backed indexes.

---

## 5. Next Action

- Add CLI smoke tests (stdout NDJSON, stderr logs, exit codes).
- Add integration tests for store rebuild + end-to-end sync.
- Decide whether to start Jetstream integration (optional).

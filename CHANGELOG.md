# @mepuka/skygent

## 0.4.1

### Patch Changes

- Fix store delete failing silently on stores with pending migrations, resolve identity resolution 404 errors for handle-based operations (add-source, remove-source --prune, remove-author, derive --include/exclude-author), fix extract-images producing no output, and detect unreadable stdin in pipe command instead of hanging indefinitely.

## 0.4.0

### Minor Changes

- Add store source registry, engagement sorting, image cache, digest command, and pipe/stream fixes.

  - **Store sources**: persistent source config (`store add-source`, `store sources`, `store remove-source`), source-aware sync with concurrent fetch and serialized writes
  - **Engagement sorting**: `--sort by-likes`, `--sort by-reposts`, `--sort by-engagement` on query
  - **Image cache**: image embed caching and query UX improvements
  - **Digest command**: new `digest` command for summarized store output
  - **Pipe fix**: use CliInput TTY flag instead of process.stdin.isTTY
  - **Refactors**: Match/Predicate for tag guards, stream-first sync semantics

## 0.3.2

### Patch Changes

- Fix global flag placement docs, add missing CLI commands, correct pipe compatibility

  - Global flags must appear before the subcommand (not after) for commands with positional args
  - Add missing commands to cli.md: sync list, watch list, view thread, pipe
  - Add --max-cycles and --until to all watch command docs
  - Correct pipe docs: compact output is not compatible with pipe (fails schema validation)

## 0.3.1

### Patch Changes

- ### Bug Fixes

  - Fix query command broken for all non-JSON output formats (#119)
  - Fix --compact help text identical to --full (#120)
  - Fix pipe command incompatible with query ndjson output (#121)
  - Add URI validation for sync/feed/post commands (#122)
  - Fix inconsistent auth error handling in graph commands (#123)
  - Fix store delete on nonexistent store giving misleading error (#124)
  - Fix store rename reporting moved:false on success (#125)
  - Reject unsupported markdown format for graph/feed/post with clear error (#126)
  - Apply compact/full preferences consistently to graph/feed/post (#127)
  - Add --limit flag to all sync commands (#128)

  ### Refactoring

  - Schema-validate CLI numeric options and URI arguments
  - Consolidate actor and duration parsing
  - Warn on unbounded collects
  - Align duration parsing and arg schemas

## 0.3.0

### Minor Changes

- ### Features

  - Add multi-store query support for cross-store searches
  - Add `pipe` command for NDJSON filtering pipelines
  - Add `store rename` command
  - Enrich graph relationships via Effect Graph
  - Add temporal time parsing and filters
  - Add count, watch limits, and sync totals
  - Default to compact JSON output

  ### Fixes

  - Improve config errors and jetstream warnings
  - Handle empty outputs and add sync heartbeat
  - Tighten multi-store ordering and filter hints
  - Batch sync commits and tune page size

  ### Refactoring

  - Centralize CLI renderers
  - Unify stream ordering and CLI helpers
  - Centralize ordering semantics

## 0.2.0

### Minor Changes

- 9fc3fa2: Package and release setup: rename to @mepuka/skygent, add CI/CD pipeline with npm publish and binary builds

# @mepuka/skygent

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

# @mepuka/skygent

## 0.8.0

### Minor Changes

- 069c524: Add store serve command with SSE streaming, batch jetstream commits for improved sync performance, harden store DB locking and stream safety, and bump effect-jetstream to 1.1.0.

## 0.7.1

### Patch Changes

- 12d90f6: Fix credential resolution order: overrides and env vars now take priority over file, and corrupt credential files no longer block the fallback chain. Rename `credentials set` flags to `--id`/`--pw` to avoid clash with root command global options.

## 0.6.0

### Minor Changes

- 79db96b: ### New Commands

  - **`actor resolve`**: Resolve DIDs to handles and vice versa with cache support
  - **`capabilities`**: Machine-readable feature discovery for agents (filters, formats, commands)

  ### CLI Ergonomics

  - **Dual store syntax**: All commands now accept both positional `<store>` and `--store` flag
  - **`--filter-help`**: Inline filter predicate reference on query commands
  - **Bulk source addition**: `--authors-file` and multiple `--author` flags for batch operations
  - **Better errors**: Improved messages for global flag positioning issues

  ### Output & Formatting

  - **`SKYGENT_OUTPUT_FORMAT`**: Environment variable for default output format
  - **Structured errors**: Machine-readable error envelope with codes for agent parsing
  - **Consistent formats**: Standardized format resolution across all commands

  ### Agent Safety

  - **`--dry-run`**: Preview sync, delete, and destructive operations before execution
  - **Idempotent operations**: Explicit `action` field (created/updated/unchanged) in responses
  - **Sync progress**: Enhanced feedback with source-level tracking and counts

  ### Analysis UX

  - **Graph summaries**: Interaction breakdowns (reply/quote/mention/repost) in graph output
  - **Community labels**: Auto-generated labels using central member handles
  - **Store descriptions**: `--description` flag on `store create`
  - **Link filtering**: New `link-contains` predicate for URL content filtering

  ### Bug Fixes

  - Handle -1 metric values from Bluesky API
  - Fix sync command help text examples
  - Add `search users` alias for handle search

## 0.5.0

### Minor Changes

- ### New Features

  - **`--count-by` option**: Group and count posts by `author`, `hashtag`, `date`, or `hour`
    ```bash
    skygent query my-store --count-by author --limit 10
    skygent query my-store --count-by hashtag --since 7d
    ```

  ### Improvements

  - **Filter detection in store names**: When passing a filter expression like `text:epstein` as a store name, the CLI now suggests using `--filter` instead
  - **User-friendly handle errors**: Handle resolution errors now show clear messages like `Handle "bbc.com" not found on Bluesky` instead of raw API errors

## 0.4.4

### Patch Changes

- **Security**: Tighten filesystem permissions on `~/.skygent/` directory (0700) and sensitive files like `credentials.json` (0600). Reject absolute paths in filter outputs to prevent writes outside store root. Add cleanup handling for temp files during store renames.

- **Features**: Add `config show` command to display resolved configuration. Add `config credentials` subcommand group with `status`, `set`, and `clear` commands for managing encrypted credentials.

- **Fixes**: Make credential status detection more robust when checking file and environment sources.

## 0.4.3

### Patch Changes

- Fix compiled binary failing to run migrations by switching from filesystem-based migration loading to static imports with Migrator.fromRecord. Homebrew and GitHub Release binaries now work correctly.

## 0.4.2

### Patch Changes

- Add `--ingest` flag to `search posts --network` for saving search results directly into a store. Fix `--since` and `--until` date-only strings (e.g. `2026-01-31`) returning HTTP 400 by normalizing to full ISO datetimes. Replace readline-based stdin parsing with raw stream reader to fix pipe truncation on long lines. Fix search ingest outputting full post JSON instead of a concise summary.

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

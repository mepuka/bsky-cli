# Output and logging

## Stdout vs stderr

- Stdout is reserved for command output (JSON, NDJSON, tables, or markdown).
- Stderr is reserved for logs, progress, and warnings.

This keeps stdout pipe-friendly.

## Output formats

- `json`: single JSON array or object
- `ndjson`: one JSON object per line
- `table`: plain text table (query only)
- `markdown`: markdown table (query only)

Notes:

- `watch` emits NDJSON `SyncResult` objects to stdout (per poll interval for timeline/feed/notifications, per Jetstream batch for `watch jetstream`).
- `sync`, `store`, `derive`, `filter`, and `view` usually emit a single JSON object, unless a subcommand uses a text format (table/tree/markdown).
- `query` defaults to `compact` unless `--format` or a non-`ndjson` `outputFormat` is set.
- Compact JSON is the default for agent workflows (store list/show, query, derive). Use `--full` for verbose JSON.
- Use `--fields` on `query` to select specific fields (supports dot notation and presets like `@minimal`).
- Multi-store `query` includes store labels by default: JSON/NDJSON add a `store` field and text formats prefix the store name. Use `--include-store` to force store labels for single-store JSON/NDJSON.

## Logs and progress

Logs are JSON lines on stderr. Example:

```json
{"timestamp":"2026-01-01T12:00:00.000Z","level":"INFO","message":"Starting sync","source":"timeline","store":"my-store"}
```

`sync` and `watch` progress reports can be suppressed with `--quiet`.

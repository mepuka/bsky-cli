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

- `watch` always emits NDJSON `SyncResult` objects to stdout (one per poll interval).
- `sync`, `store`, `derive`, `filter`, and `view` emit a single JSON object.
- `query` uses `--format` or the configured `outputFormat` (default: `ndjson`).

## Logs and progress

Logs are JSON lines on stderr. Example:

```json
{"timestamp":"2026-01-01T12:00:00.000Z","level":"INFO","message":"Starting sync","source":"timeline","store":"my-store"}
```

`sync` and `watch` progress reports can be suppressed with `--quiet`.

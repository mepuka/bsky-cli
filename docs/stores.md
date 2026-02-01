# Stores

A store is an append-only event log plus indexes for querying Bluesky posts.

## Store names

Store names must match this pattern:

- `^[a-z0-9][a-z0-9-_]{1,63}$`

That means lowercase letters or digits, may include `-` or `_`, and must be 2-64 characters.

To rename a store, use `skygent store rename <old> <new>`.

## Store root layout

The default store root is `~/.skygent`. Contents:

- `kv/`: internal key-value storage for event log + indexes
- `filters/`: saved filter definitions (`filter create`)
- `credentials.json`: encrypted credentials file (optional)
- `config.json`: global app config

The internal `kv/` structure is not stable; treat it as implementation detail.

## Store configuration

When creating a store you can provide a `StoreConfig` JSON. It controls filter materialization outputs.
Currently only `filters` are used by the CLI; `format`, `autoSync`, and `syncInterval` are stored for future use.

**Idempotency:** `store create` is idempotent — if the store already exists, it returns the
existing store reference. The provided `--config-json` is ignored for existing stores; config
is only applied on first creation. To change config, delete and recreate the store.

Note: `StoreConfig.filters` are **materialized views**, not sync/query filters. Use `--filter` / `--filter-json` on
`sync` or `query` to filter ingestion and query results.

Example:

```json
{
  "format": { "json": true, "markdown": false },
  "autoSync": false,
  "filters": [
    {
      "name": "ai-posts",
      "expr": { "_tag": "Hashtag", "tag": "#ai" },
      "output": { "path": "outputs/ai-posts", "json": true, "markdown": true }
    }
  ]
}
```

Notes:

- `output.path` is relative to `<storeRoot>/stores/<name>/` unless absolute.
- Each materialized filter output writes:
  - `posts.json` (if `json: true`)
  - `posts.md` (if `markdown: true`)
  - `manifest.json`

Use `store materialize <name>` to regenerate outputs.

## Stats and summary

Use `store stats <name>` for per-store counts (posts, authors, top hashtags/authors, date range, size).
Use `store summary` for a compact overview across all stores, including derived staleness status.

## Tree view

Use `store tree` to visualize lineage relationships as ASCII output. `--format table` prints
separate `Stores` and `Derivations` sections with labeled columns. Use `--format json` for
structured output. Pass `--ansi` for colored output and `--width` to control wrapping.

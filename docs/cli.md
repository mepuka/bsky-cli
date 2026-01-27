# CLI reference

The CLI binary is `skygent`. In this repo, run it via:

```bash
bun run index.ts <command>
```

## Global options

These can be used with any command and override config/env defaults:

- `--service <url>`: Override Bluesky service URL.
- `--store-root <path>`: Override storage root directory.
- `--output-format <json|ndjson|markdown|table>`: Default output format (used by `query`).
- `--identifier <handle>`: Override Bluesky identifier.
- `--password <value>`: Override Bluesky password (redacted).
- `--compact`: Reduce JSON output verbosity for agent consumption.

## Commands

### store

Manage stores.

- `store create <name> [--config-json '<StoreConfig JSON>']`
- `store list`
- `store show <name>`
- `store delete <name> --force`
- `store materialize <name> [--filter <filter-name>]`

Examples:

```bash
bun run index.ts store create my-store
bun run index.ts store show my-store
bun run index.ts store delete my-store --force
```

Provide store config as JSON (single quotes recommended):

```bash
bun run index.ts store create my-store \
  --config-json '{"format":{"json":true,"markdown":false},"autoSync":false,"filters":[]}'
```

### sync

One-off ingestion into a store.

- `sync timeline --store <name> [--filter <dsl>] [--filter-json <json>] [--quiet]`
- `sync feed <uri> --store <name> [--filter <dsl>] [--filter-json <json>] [--quiet]`
- `sync notifications --store <name> [--filter <dsl>] [--filter-json <json>] [--quiet]`

Examples:

```bash
bun run index.ts sync timeline --store my-store
bun run index.ts sync feed at://did:plc:... --store my-store
```

### watch

Repeated polling + streaming NDJSON results to stdout.

- `watch timeline --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--interval-ms <ms>] [--quiet]`
- `watch feed <uri> --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--interval-ms <ms>] [--quiet]`
- `watch notifications --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--interval-ms <ms>] [--quiet]`

`--interval` accepts strings like "30 seconds" or "500 millis". Default is 30 seconds. `--interval-ms` is deprecated.

### query

Query stored posts.

- `query <store> [--range <start>..<end>] [--filter <dsl>] [--filter-json <json>] [--limit <n>] [--format <json|ndjson|markdown|table>] [--fields <fields>]`

Examples:

```bash
bun run index.ts query my-store --limit 10 --format table
bun run index.ts query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z
bun run index.ts query my-store --fields uri,author,text --limit 5
```

### derive

Create a derived store by applying a filter to a source store.

- `derive <source> <target> [--filter <dsl>] [--filter-json <json>] [--mode <event-time|derive-time>] [--reset] [--yes]`

Notes:

- `--mode event-time` (default) disallows effectful filters (Llm, Trending, HasValidLinks).
- `--reset` is destructive and requires `--yes`.

### view

Check derived view status.

- `view status <view> <source>`

### filter

Manage saved filters (for reuse in DSL via `@name`).

- `filter list`
- `filter show <name>`
- `filter create <name> --filter <dsl>`
- `filter create <name> --filter-json <json>`
- `filter delete <name>`
- `filter validate-all`
- `filter validate --filter <dsl>`
- `filter validate --filter-json <json>`
- `filter test --filter <dsl> --post-uri <uri>`
- `filter test --filter-json <json> --post-json <raw-post-json>`
- `filter explain --filter <dsl> --post-uri <uri>`
- `filter describe --filter <dsl> [--format <text|json>]`
- `filter benchmark --store <name> --filter <dsl> [--sample-size <n>]`

## Exit codes

- `0`: success
- `1`: unknown error
- `2`: validation/input/config/filter-library errors
- `3`: store not found
- `5`: Bluesky source errors
- `7`: store I/O or index errors
- `8`: filter compile/eval errors

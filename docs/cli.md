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
- `--full`: Use verbose JSON output (compact is the default).

Tips:

- Compact output is the default; use `--full` for verbose JSON payloads.
- For sync/watch commands, add `--quiet` to suppress progress logs.

## Commands

### store

Manage stores.

- `store create <name> [--config-json '<StoreConfig JSON>']`
- `store list`
- `store show <name>`
- `store stats <name>`
- `store summary`
- `store tree [--format <tree|table|json>] [--ansi] [--width <n>]`
- `store rename <from> <to>`
- `store delete <name> --force`
- `store materialize <name> [--filter <filter-name>]`

Examples:

```bash
bun run index.ts store create my-store
bun run index.ts store show my-store
bun run index.ts store stats my-store
bun run index.ts store summary
bun run index.ts store tree --format table
bun run index.ts store tree --ansi --width 100
bun run index.ts store rename old-store new-store
bun run index.ts store delete my-store --force
```

`store tree --format table` prints two labeled sections (`Stores` and `Derivations`) with column headers.
Use `--ansi` to enable colored tree output and `--width` to control wrapping width.

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
- `sync author <actor> --store <name> [--filter <posts_with_replies|posts_no_replies|posts_with_media|posts_and_author_threads>] [--include-pins] [--post-filter <dsl>] [--post-filter-json <json>] [--quiet]`
- `sync thread <uri> --store <name> [--depth <n>] [--parent-height <n>] [--filter <dsl>] [--filter-json <json>] [--quiet]`
- `sync jetstream --store <name> [--filter <dsl>] [--filter-json <json>] [--limit <n> | --duration <duration>] [--endpoint <url>] [--collections <csv>] [--dids <csv>] [--cursor <micros>] [--compress] [--max-message-size <bytes>] [--strict] [--max-errors <n>] [--quiet]`

Examples:

```bash
bun run index.ts sync timeline --store my-store
bun run index.ts sync feed at://did:plc:... --store my-store
bun run index.ts sync author alice.bsky.social --store my-store --filter posts_no_replies
bun run index.ts sync thread at://did:plc:.../app.bsky.feed.post/... --store my-store
bun run index.ts sync jetstream --store my-store --limit 500
```

Notes:

- Jetstream sync requires `--limit` or `--duration` to avoid infinite runs.
- Only `app.bsky.feed.post` is supported for `--collections` currently.
- `--strict` stops on the first error and does not advance the checkpoint.
- `--max-errors` stops after exceeding N errors.

### watch

Repeated polling + streaming NDJSON results to stdout.

- `watch timeline --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--quiet]`
- `watch feed <uri> --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--quiet]`
- `watch notifications --store <name> [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--quiet]`
- `watch author <actor> --store <name> [--filter <posts_with_replies|posts_no_replies|posts_with_media|posts_and_author_threads>] [--include-pins] [--post-filter <dsl>] [--post-filter-json <json>] [--interval <duration>] [--quiet]`
- `watch thread <uri> --store <name> [--depth <n>] [--parent-height <n>] [--filter <dsl>] [--filter-json <json>] [--interval <duration>] [--quiet]`
- `watch jetstream --store <name> [--filter <dsl>] [--filter-json <json>] [--endpoint <url>] [--collections <csv>] [--dids <csv>] [--cursor <micros>] [--compress] [--max-message-size <bytes>] [--strict] [--max-errors <n>] [--quiet]`

`--interval` accepts strings like "30 seconds" or "500 millis". Default is 30 seconds.

### query

Query stored posts.

- `query <store...> [--range <start>..<end>] [--filter <dsl>] [--filter-json <json>] [--limit <n>] [--format <json|ndjson|markdown|table|compact|card|thread>] [--fields <fields>] [--include-store]`

Examples:

```bash
bun run index.ts query my-store --limit 10 --format table
bun run index.ts query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z
bun run index.ts query my-store --fields uri,author,text --limit 5
bun run index.ts query store-a,store-b --format ndjson
```

Multi-store queries accept comma-separated store lists or repeated store arguments.

### derive

Create a derived store by applying a filter to a source store.

- `derive <source> <target> [--filter <dsl>] [--filter-json <json>] [--mode <event-time|derive-time>] [--reset] [--yes]`

Notes:

- `--mode event-time` (default) disallows effectful filters (Trending, HasValidLinks).
- `--reset` is destructive and requires `--yes`.

### view

Check derived view status.

- `view status <view> <source>`

### config

Configuration helpers.

- `config check`

Runs a series of health checks and outputs a JSON report with an `ok` boolean and a `checks` array. Each check has a `name`, `status` (`ok`, `warn`, or `error`), and an optional `message`.

Checks performed:

1. **store-root** -- verifies the store root directory exists and is writable.
2. **credentials** -- verifies credentials are configured and loadable.
3. **bluesky** -- attempts a Bluesky API call (skipped when credentials are missing).

Example:

```bash
bun run index.ts config check
```

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

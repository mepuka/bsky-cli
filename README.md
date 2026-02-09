# @mepuka/skygent

Agent-first Bluesky data filtering and monitoring CLI built with [Effect](https://effect.website).

Sync posts from timelines, feeds, lists, authors, and the real-time Jetstream firehose into local SQLite stores. Query, filter, derive, and export data with a powerful filter DSL and multiple output formats. Designed to be operated by CLI coding agents — Claude Code, Codex CLI, and similar tools — with structured errors, machine-readable output, and self-describing capabilities.

## Install

### npm / bun

```bash
bun add -g @mepuka/skygent
```

### From source

```bash
git clone https://github.com/mepuka/skygent-bsky.git
cd skygent-bsky
bun install
bun run index.ts --help
```

### Standalone binary

Download a prebuilt binary from [GitHub Releases](https://github.com/mepuka/skygent-bsky/releases), or build locally:

```bash
bun run build:binary
./skygent --help
```

Cross-platform targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`.

## Agent-first design

Skygent is built so an LLM agent can discover commands, interpret output, recover from errors, and chain operations without human intervention.

**Self-describing capabilities** — an agent's first call can be `skygent capabilities --format json`, which returns every command, filter predicate, output format, and source type in machine-readable JSON.

**Structured error envelope** — set `SKYGENT_JSON_ERRORS=1` and every error returns a JSON object with `type`, `code`, `message`, `suggestion`, and `details`. Validation errors include `received`, `expected`, and `fix` fields so the agent can self-correct:

```json
{
  "type": "StoreNotFound",
  "code": "STORE_NOT_FOUND",
  "exitCode": 3,
  "message": "Store 'my-stor' not found",
  "suggestion": "Run: skygent store list"
}
```

**Semantic exit codes** — `0` success, `2` input validation, `3` store not found, `5` network error, `7` storage I/O, `8` filter compilation. Agents can implement retry strategies based on the code alone.

**NDJSON everywhere** — every command supports `--format ndjson` for streaming, one-JSON-object-per-line output. Pair with the `pipe` command to chain filter operations without intermediate files.

**Dry-run everything** — sync, derive, and watch commands all support `--dry-run` so agents can validate before committing. Field projection (`--fields @minimal`) and `--count` reduce token cost when full output isn't needed.

**Inline help for filter authoring** — `--filter-help` on any filtering command dumps the full predicate reference with examples.

**HTTP mode** — `skygent store serve` exposes a REST API with SSE streaming for agents that prefer HTTP over CLI.

## Authentication

Skygent needs a Bluesky handle and [app password](https://bsky.app/settings/app-passwords). Credentials are resolved in this order:

1. CLI flags: `--identifier` and `--password`
2. Environment variables: `SKYGENT_IDENTIFIER` and `SKYGENT_PASSWORD`
3. Encrypted credential file (`~/.skygent/credentials.json`, requires a credentials key)

Credentials key resolution order:

1. Environment: `SKYGENT_CREDENTIALS_KEY`
2. Keyfile: `~/.skygent/credentials.key`

Manage the encrypted credential file with `skygent config credentials`.
Manage the credentials key with `skygent config credentials key set|status|clear`.

The simplest setup:

```bash
cp .env.example .env
# Edit .env with your handle and app password
```

Bun loads `.env` automatically.

## Quickstart

```bash
# Create a store
skygent store create my-store

# Sync your timeline
skygent sync timeline --store my-store

# Query recent posts
skygent query my-store --limit 10 --format table

# Stream live posts from Jetstream
skygent watch jetstream --store my-store

# Derive a filtered store
skygent derive my-store ai-posts --filter 'hashtag:#ai OR hashtag:#ml'

# Search posts locally
skygent search posts "effect typescript" --store my-store

# Analyze social graph
skygent graph interactions my-store --format table
skygent graph centrality my-store --metric pagerank --limit 10
```

## Commands

### `store` — Manage local stores

| Subcommand | Description |
|---|---|
| `store create <name>` | Create a new store |
| `store list` | List all stores |
| `store show <name>` | Show store config and metadata |
| `store update <name>` | Update store metadata |
| `store rename <from> <to>` | Rename a store |
| `store delete <name> --force` | Delete a store |
| `store stats <name>` | Show store statistics |
| `store info <name>` | Alias for `store stats` |
| `store analytics <name>` | Time-bucketed analytics (posts, authors, engagement by day/hour) |
| `store summary` | Summarize all stores |
| `store tree` | Visualize store lineage |
| `store materialize <name>` | Materialize filter outputs to disk |
| `store sources <name>` | List configured sources for a store |
| `store add-source <name>` | Add an author, feed, list, timeline, or jetstream source |
| `store remove-source <name> <id>` | Remove a configured source |
| `store authors <name>` | List authors with stats |
| `store remove-author <name> <actor>` | Remove an author's posts from a store |
| `store cache <name>` | Cache image embeds |
| `store cache-status <name>` | Report image cache coverage |
| `store cache-clean` | Clear the image cache |
| `store cache-sweep <name>` | Sweep orphaned image cache files |
| `store cache-ttl-sweep <name>` | Sweep expired cache files (TTL-based) |
| `store serve` | Start HTTP server with SSE streaming (`--port`, `--poll-interval`) |

### `sync` — One-time data sync

| Subcommand | Description |
|---|---|
| `sync <store>` | Sync all configured sources |
| `sync timeline` | Sync your timeline |
| `sync feed <uri>` | Sync a feed generator |
| `sync list <uri>` | Sync a list feed |
| `sync author <actor>` | Sync posts from an author |
| `sync thread <uri>` | Sync a thread (parents + replies) |
| `sync notifications` | Sync notifications |
| `sync jetstream` | Sync from Jetstream firehose |

All sync commands accept `--store`, `--filter`, `--post-filter`, `--quiet`, `--refresh`, `--dry-run`, `--limit`, `--cache-images`, and `--filter-help`.

### `watch` — Continuous sync

Same subcommands as `sync`, with continuous polling. Supports `--interval` (default: 30s), `--max-cycles`, and `--until`.

```bash
skygent watch timeline --store my-store --interval "5 minutes"
skygent watch jetstream --store my-store --until "10 minutes"
```

### `query` — Query stored posts

```bash
skygent query my-store --limit 25 --format table
skygent query my-store --filter 'hashtag:#ai' --sort desc --format json
skygent query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z
skygent query my-store --fields @minimal --newest-first
skygent query my-store --fields @images --resolve-images
skygent query my-store --extract-images --format json
skygent query store-a,store-b --format ndjson
skygent query my-store --filter 'hashtag:#ai' --count-by hashtag
skygent query my-store --filter 'engagement:minLikes=50' --count
```

**Formats:** `json`, `ndjson`, `table`, `markdown`, `compact`, `card`, `thread`

**Sorting:** `--sort asc|desc|by-likes|by-reposts|by-replies|by-quotes|by-engagement`, `--newest-first`

**Field presets:** `@minimal`, `@social`, `@full`, `@images`, `@embeds`, `@media`, or comma-separated field names with dot notation (use `*` to traverse arrays, e.g. `images.*.alt`).

**Image options:** `--extract-images`, `--resolve-images`, `--cache-images`, `--no-cache-images-thumbnails`.

**Aggregation:** `--count` for totals, `--count-by author|hashtag|date|hour` for breakdowns.

Multi-store queries accept comma-separated store lists and include store names in output by default.

### `derive` — Create derived stores

Apply a filter to a source store to produce a new filtered store:

```bash
skygent derive source-store target-store --filter 'hashtag:#ai'
```

**Modes:**
- `event-time` (default) — Pure filters only, replayable
- `derive-time` — Allows effectful filters (Trending, HasValidLinks)

Supports `--include-author`, `--exclude-author`, `--reset --yes`, and `--dry-run`.

### `filter` — Filter management and testing

Run `skygent filter help` for a compact list of predicates and aliases.

| Subcommand | Description |
|---|---|
| `filter create <name>` | Save a named filter |
| `filter list` | List saved filters |
| `filter show <name>` | Show a saved filter |
| `filter delete <name>` | Delete a saved filter |
| `filter help` | Show filter DSL and JSON help |
| `filter validate` | Validate a filter expression |
| `filter test` | Test a filter against a post |
| `filter explain` | Explain why a post matches |
| `filter benchmark` | Benchmark filter performance |
| `filter describe` | Describe a filter in plain text |

### `search` — Search content

| Subcommand | Description |
|---|---|
| `search posts <query>` | Search posts locally or `--network` |
| `search handles <query>` | Search Bluesky profiles |
| `search feeds <query>` | Search feed generators |

Network search supports `--ingest --store <name>` to save results locally.

### `graph` — Social graph

| Subcommand | Description |
|---|---|
| `graph followers <actor>` | List followers |
| `graph follows <actor>` | List follows |
| `graph known-followers <actor>` | Mutual followers |
| `graph relationships <actor>` | Relationship status (`--others actor1,actor2`) |
| `graph interactions <store>` | Build interaction network from store posts |
| `graph centrality <store>` | Rank actors by centrality (PageRank or degree) |
| `graph communities <store>` | Detect communities (label propagation) |
| `graph stores` | Cross-store topology from lineage data |
| `graph lists <actor>` | Lists created by actor |
| `graph list <uri>` | View a list's members |
| `graph blocks` | Your blocked accounts |
| `graph mutes` | Your muted accounts |

### `feed` — Feed generators

| Subcommand | Description |
|---|---|
| `feed show <uri>` | Show feed details |
| `feed batch <uri>...` | Fetch multiple feeds |
| `feed by <actor>` | List feeds by an actor |

### `post` — Post engagement

| Subcommand | Description |
|---|---|
| `post likes <uri>` | Who liked a post |
| `post reposted-by <uri>` | Who reposted |
| `post quotes <uri>` | Quote posts |

### `view` — Inspect threads and derivations

| Subcommand | Description |
|---|---|
| `view thread <uri>` | Display a thread |
| `view status <view> <source>` | Check if a derived view is stale |

### `digest` — Store summaries

```bash
skygent digest my-store --since 24h --format table
```

Generates a summary of store content over a time range: top posts, hashtags, active authors, volume by hour/day.

### `actor` — Identity resolution

```bash
skygent actor resolve alice.bsky.social bob.bsky.social --format json
```

Resolves handles to DIDs and vice versa. Supports `--cache-only` for offline use and `--strict` for API verification.

### `pipe` — Stream filtering

```bash
cat posts.ndjson | skygent pipe --filter 'hashtag:#ai' --on-error skip
```

Reads NDJSON from stdin, applies a filter expression, emits matching posts. Useful for chaining with other tools.

### `image-cache` — Image cache management

| Subcommand | Description |
|---|---|
| `image-cache sweep` | Sweep expired images (`--force` to delete, default: dry-run) |

### `capabilities` — Agent discovery

```bash
skygent capabilities --format json
```

Returns CLI version, all commands, filter predicates with examples, supported output formats, and source types. Designed for agent bootstrapping.

### `config` — Configuration

```bash
skygent config check          # Run health checks
```

## Filter DSL

Filters are passed via `--filter` (DSL string) or `--filter-json` (JSON AST).

### Primitives

| Filter | Example | Description |
|---|---|---|
| `hashtag:#tag` | `hashtag:#ai` | Match posts with hashtag |
| `hashtagin:#a,#b` | `hashtagin:#ai,#ml,#dl` | Match any of several hashtags |
| `author:handle` | `author:alice.bsky.social` | Match posts by author |
| `authorin:a,b` | `authorin:alice.bsky.social,bob.bsky.social` | Match any of several authors |
| `contains:"text"` | `contains:"bluesky"` | Text search (case-insensitive) |
| `regex:/pattern/flags` | `regex:/hello\|world/i` | Regex match |
| `language:code` | `language:en,es` | Match languages |
| `date:<start>..<end>` | `date:2024-01-01..2024-01-31` | Date range (ISO 8601) |
| `since:duration` | `since:24h` | Posts from last N duration |
| `until:timestamp` | `until:2024-01-31T23:59:59Z` | Posts until timestamp |
| `age:comparator` | `age:<24h`, `age:>=7d` | Post age with comparator |
| `engagement:thresholds` | `engagement:minLikes=100,minReposts=5` | Engagement thresholds |
| `is:type` | `is:reply`, `is:quote`, `is:repost`, `is:original` | Post type |
| `has:media_type` | `has:images`, `has:video`, `has:links`, `has:media`, `has:embed` | Media presence |
| `min-images:N` | `min-images:2` | Minimum image count |
| `alt-text:text` | `alt-text:"accessibility"` | Alt text contains text or regex |
| `no-alt-text` | `no-alt-text` | Images without alt text |
| `link-contains:text` | `link-contains:substack.com` | Links containing substring |
| `links` | `links`, `links:/pattern/` | Valid external links (effectful) |
| `trending:#tag` | `trending:#ai` | Trending hashtag (effectful) |
| `@saved-name` | `@my-filter` | Reference a saved filter |

### Aliases

`from:` = `author:`, `tag:` = `hashtag:`, `text:` = `contains:`, `lang:` = `language:`, `tags:` = `hashtagin:`, `authors:` = `authorin:`

### Boolean operators

```
hashtag:#ai AND author:user.bsky.social
hashtag:#ai OR hashtag:#ml
NOT hashtag:#spam
(hashtag:#ai OR hashtag:#ml) AND engagement:minLikes=10
```

Operators: `AND` / `&&`, `OR` / `||`, `NOT` / `!`, parentheses for grouping.

### Effectful filters

`trending` and `links` (valid link checking) require network access and cannot be used in `event-time` derivation mode. Both support `onError=include|exclude|retry` policies.

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SKYGENT_IDENTIFIER` | — | Bluesky handle or DID |
| `SKYGENT_PASSWORD` | — | App password |
| `SKYGENT_CREDENTIALS_KEY` | — | Master key for encrypted credential storage |
| `SKYGENT_SERVICE` | `https://bsky.social` | Bluesky service URL |
| `SKYGENT_STORE_ROOT` | `~/.skygent` | Root storage directory |
| `SKYGENT_OUTPUT_FORMAT` | `ndjson` | Default output format |
| `SKYGENT_JSON_ERRORS` | `false` | Enable structured JSON error envelope |
| `SKYGENT_BSKY_RATE_LIMIT` | `250 millis` | Min delay between API calls |
| `SKYGENT_BSKY_RETRY_MAX` | `5` | Max retry attempts |
| `SKYGENT_SYNC_CONCURRENCY` | `5` | Concurrent sync workers |

### Global flags

- `--full` — Use verbose JSON output (compact is the default)
- `--quiet` — Suppress progress output
- `--log-format json|human` — Control log format

## Architecture

Skygent is built entirely on Effect with a layered service architecture:

- **Domain** (`src/domain/`) — Data models for posts, stores, filters, events, and derivations using Effect Schema
- **Services** (`src/services/`) — Business logic: Bluesky API client, SQLite store, sync engine, filter runtime, derivation engine, graph builder
- **CLI** (`src/cli/`) — Command definitions, output formatting, error handling

Stores are local SQLite databases with an append-only event log. Each store has its own `index.sqlite` with FTS5 full-text search, WAL mode, and optimized pragmas. Derivations track lineage between stores and support incremental processing with checkpoints.

The sync engine supports resumable checkpoints, configurable concurrency, and a four-stage pipeline: source fetch, parse, filter, store. The Jetstream engine provides a separate real-time path with batched commit processing.

## Security

- Passwords are handled as `Redacted` values and never logged
- Encrypted credential storage uses AES-GCM with PBKDF2 (100,000 iterations)
- Filesystem permissions enforced (0700 directories, 0600 files)
- Avoid putting passwords in config files; use environment variables or the credential store

## Documentation

Detailed docs are in `docs/`:

- [Getting Started](docs/getting-started.md)
- [CLI Reference](docs/cli.md)
- [Filters](docs/filters.md)
- [Configuration](docs/configuration.md)
- [Credentials](docs/credentials.md)
- [Stores](docs/stores.md)
- [Output Formats](docs/outputs.md)

## License

MIT

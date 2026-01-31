# @mepuka/skygent

Composable Bluesky data filtering and monitoring CLI built with [Effect](https://effect.website).

Sync posts from timelines, feeds, lists, authors, and the real-time Jetstream firehose into local SQLite stores. Query, filter, derive, and export data with a powerful filter DSL and multiple output formats.

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

## Authentication

Skygent needs a Bluesky handle and [app password](https://bsky.app/settings/app-passwords). Credentials are resolved in this order:

1. CLI flags: `--identifier` and `--password`
2. Environment variables: `SKYGENT_IDENTIFIER` and `SKYGENT_PASSWORD`
3. Encrypted credential file (`~/.skygent/credentials.json`, requires `SKYGENT_CREDENTIALS_KEY`)

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
```

## Commands

### `store` -- Manage local stores

| Subcommand | Description |
|---|---|
| `store create <name>` | Create a new store |
| `store list` | List all stores |
| `store show <name>` | Show store config and metadata |
| `store rename <from> <to>` | Rename a store |
| `store delete <name> --force` | Delete a store |
| `store stats <name>` | Show store statistics |
| `store summary` | Summarize all stores |
| `store tree` | Visualize store lineage |
| `store materialize <name>` | Materialize filter outputs to disk |

### `sync` -- One-time data sync

| Subcommand | Description |
|---|---|
| `sync timeline` | Sync your timeline |
| `sync feed <uri>` | Sync a feed generator |
| `sync list <uri>` | Sync a list feed |
| `sync author <actor>` | Sync posts from an author |
| `sync thread <uri>` | Sync a thread (parents + replies) |
| `sync notifications` | Sync notifications |
| `sync jetstream` | Sync from Jetstream firehose |

All sync commands accept `--store`, `--filter`, `--quiet`, and `--refresh`.

### `watch` -- Continuous sync

Same subcommands as `sync`, with continuous polling. Supports `--interval` (default: 30s).

```bash
skygent watch timeline --store my-store --interval "5 minutes"
```

### `query` -- Query stored posts

```bash
skygent query my-store --limit 25 --format table
skygent query my-store --filter 'hashtag:#ai' --sort desc --format json
skygent query my-store --range 2024-01-01T00:00:00Z..2024-01-31T00:00:00Z
skygent query my-store --fields @minimal --newest-first
```

**Formats:** `json`, `ndjson`, `table`, `markdown`, `compact`, `card`, `thread`

**Field presets:** `@minimal`, `@social`, `@full`, or comma-separated field names with dot notation.

### `derive` -- Create derived stores

Apply a filter to a source store to produce a new filtered store:

```bash
skygent derive source-store target-store --filter 'hashtag:#ai'
```

**Modes:**
- `event-time` (default) -- Pure filters only, replayable
- `derive-time` -- Allows effectful filters (Trending, HasValidLinks)

### `filter` -- Filter management and testing

Tip: run `skygent filter help` for a compact list of predicates and aliases.

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

### `search` -- Search content

| Subcommand | Description |
|---|---|
| `search posts <query>` | Search posts locally or `--network` |
| `search handles <query>` | Search Bluesky profiles |
| `search feeds <query>` | Search feed generators |

### `graph` -- Social graph

| Subcommand | Description |
|---|---|
| `graph followers <actor>` | List followers |
| `graph follows <actor>` | List follows |
| `graph known-followers <actor>` | Mutual followers |
| `graph relationships <actor>` | Relationship status |
| `graph lists <actor>` | Lists created by actor |
| `graph list <uri>` | View a list's members |
| `graph blocks` | Your blocked accounts |
| `graph mutes` | Your muted accounts |

### `feed` -- Feed generators

| Subcommand | Description |
|---|---|
| `feed show <uri>` | Show feed details |
| `feed batch <uri>...` | Fetch multiple feeds |
| `feed by <actor>` | List feeds by an actor |

### `post` -- Post engagement

| Subcommand | Description |
|---|---|
| `post likes <uri>` | Who liked a post |
| `post reposted-by <uri>` | Who reposted |
| `post quotes <uri>` | Quote posts |

### `view` -- Inspect threads and derivations

| Subcommand | Description |
|---|---|
| `view thread <uri>` | Display a thread |
| `view status <view> <source>` | Check if a derived view is stale |

### `config` -- Configuration

```bash
skygent config check          # Run health checks
```

## Filter DSL

Filters are passed via `--filter` (DSL string) or `--filter-json` (JSON AST).

### Primitives

| Filter | Example |
|---|---|
| `hashtag:#tag` | Match posts with hashtag |
| `author:handle.bsky.social` | Match posts by author |
| `contains:"text"` | Text search (case-insensitive by default) |
| `regex:/pattern/i` | Regex match |
| `language:en,es` | Match languages |
| `date:<start>..<end>` | Date range (ISO 8601) |
| `engagement:minLikes=100` | Engagement thresholds |
| `is:reply` | Post type (`reply`, `quote`, `repost`, `original`) |
| `has:images` | Media presence (`images`, `video`, `links`, `media`, `embed`) |
| `@saved-name` | Reference a saved filter |

### Aliases

`from:` = `author:`, `tag:` = `hashtag:`, `text:` = `contains:`, `lang:` = `language:`

### List filters

`authorin:alice,bob,charlie` and `hashtagin:#ai,#ml,#dl`

### Boolean operators

```
hashtag:#ai AND author:user.bsky.social
hashtag:#ai OR hashtag:#ml
NOT hashtag:#spam
(hashtag:#ai OR hashtag:#ml) AND engagement:minLikes=10
```

Operators: `AND` / `&&`, `OR` / `||`, `NOT` / `!`, parentheses for grouping.

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SKYGENT_IDENTIFIER` | -- | Bluesky handle or DID |
| `SKYGENT_PASSWORD` | -- | App password |
| `SKYGENT_CREDENTIALS_KEY` | -- | Master key for encrypted credential storage |
| `SKYGENT_SERVICE` | `https://bsky.social` | Bluesky service URL |
| `SKYGENT_STORE_ROOT` | `~/.skygent` | Root storage directory |
| `SKYGENT_OUTPUT_FORMAT` | `ndjson` | Default output format |
| `SKYGENT_BSKY_RATE_LIMIT` | `250 millis` | Min delay between API calls |
| `SKYGENT_BSKY_RETRY_MAX` | `5` | Max retry attempts |
| `SKYGENT_SYNC_CONCURRENCY` | `5` | Concurrent sync workers |

### Global flags

- `--full` -- Use verbose JSON output (compact is the default)
- `--quiet` -- Suppress progress output
- `--log-format json|human` -- Control log format

## Architecture

Skygent is built entirely on Effect with a layered service architecture:

- **Domain** (`src/domain/`) -- Data models for posts, stores, filters, events, and derivations using Effect Schema
- **Services** (`src/services/`) -- Business logic: Bluesky API client, SQLite store, sync engine, filter runtime, derivation engine
- **CLI** (`src/cli/`) -- Command definitions, output formatting, error handling

Stores are local SQLite databases with an append-only event log. Derivations track lineage between stores and support incremental processing with checkpoints.

## Security

- Passwords are handled as `Redacted` values and never logged
- Encrypted credential storage uses AES-GCM with PBKDF2 (100,000 iterations)
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

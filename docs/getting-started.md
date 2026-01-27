# Getting started

## Prereqs

- Bun v1.x
- Bluesky account (identifier and password)

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env` and set at least:

- `SKYGENT_IDENTIFIER`
- `SKYGENT_PASSWORD`

Optional: set `SKYGENT_STORE_ROOT` and `SKYGENT_OUTPUT_FORMAT` to override defaults.

## Quick start

```bash
bun run index.ts store create my-store
bun run index.ts sync timeline --store my-store
bun run index.ts query my-store --limit 5 --format table
```

## Sync a feed

```bash
bun run index.ts sync feed <feed-uri> --store my-store
```

## Watch for updates

```bash
bun run index.ts watch timeline --store my-store --interval "30 seconds"
```

## Use filters

```bash
bun run index.ts sync timeline --store my-store --filter 'hashtag:#ai AND author:user.bsky.social'
```

Or JSON:

```bash
bun run index.ts sync timeline --store my-store \
  --filter-json '{"_tag":"Hashtag","tag":"#ai"}'
```

For more details:

- Filters: `docs/filters.md`
- CLI reference: `docs/cli.md`
- Configuration: `docs/configuration.md`

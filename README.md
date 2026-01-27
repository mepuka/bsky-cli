# skygent-bsky

To install dependencies:

```bash
bun install
```

Create a local `.env` from `.env.example` and set credentials:

```bash
cp .env.example .env
```

To run:

```bash
bun run index.ts
```

## Quickstart

```bash
# List stores (compact JSON for agents)
bun run index.ts store list --compact

# Sync timeline into a store
bun run index.ts sync timeline --store my-store --quiet

# Query recent posts as a table
bun run index.ts query my-store --limit 10 --format table

# Stream Jetstream posts
bun run index.ts watch jetstream --store my-store --quiet
```

Tips:
- Add `--compact` to reduce JSON output size.
- Add `--quiet` to suppress progress logs during sync/watch commands.

## Documentation

- docs/README.md
- docs/getting-started.md
- docs/cli.md
- docs/filters.md
- docs/configuration.md
- docs/credentials.md
- docs/stores.md
- docs/outputs.md

## Security notes

- Credentials are loaded via Effect `Redacted` config and are not logged.
- Encrypted credential storage uses `SKYGENT_CREDENTIALS_KEY` (AES-GCM).
- Avoid putting passwords in `config.json`; use env or the credential store instead.
- Resource warnings can be configured via `SKYGENT_RESOURCE_*` env vars.

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

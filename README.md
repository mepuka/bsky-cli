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

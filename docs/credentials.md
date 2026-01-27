# Credentials

Skygent resolves Bluesky credentials in this order:

1. CLI overrides: `--identifier`, `--password`
2. Environment: `SKYGENT_IDENTIFIER`, `SKYGENT_PASSWORD`
3. Encrypted credentials file: `<storeRoot>/credentials.json`
4. Config file identifier: `identifier` in `config.json` (identifier only)

If a credentials file exists but `SKYGENT_CREDENTIALS_KEY` is not set, the CLI will error.

## Encrypted credentials file

- Path: `<storeRoot>/credentials.json`
- Encryption: AES-GCM with a key derived from `SKYGENT_CREDENTIALS_KEY`

There is no dedicated CLI command to create this file yet; use env variables unless you already have a credentials file.

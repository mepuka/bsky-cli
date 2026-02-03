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

You can create or update this file with:

```bash
skygent config credentials set --identifier handle.bsky.social --password app-password
```

Requires `SKYGENT_CREDENTIALS_KEY` to be set in the environment.

## Security model

- **Encrypted at rest:** `credentials.json` (only the identifier + password).
- **Plaintext at rest:** `config.json`, store databases, derived outputs, and cache files.
- **Filesystem permissions:** The CLI creates the store root and sensitive files with restrictive permissions (0700 for directories, 0600 for sensitive files) when possible.

## Password flag caution

Passing `--password` on the command line may be recorded in shell history. For automation, prefer environment variables or `config credentials set` in a protected shell session.

## Key rotation

1. Set a new `SKYGENT_CREDENTIALS_KEY` in your environment.
2. Re-save credentials with the new key:

```bash
skygent config credentials set --identifier handle.bsky.social --password app-password
```

If you no longer have the old key, delete `<storeRoot>/credentials.json` and re-save credentials.

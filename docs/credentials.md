# Credentials

Skygent resolves Bluesky credentials in this order:

1. CLI overrides: `--identifier`, `--password`
2. Environment: `SKYGENT_IDENTIFIER`, `SKYGENT_PASSWORD`
3. Encrypted credentials file: `<storeRoot>/credentials.json`
4. Config file identifier: `identifier` in `config.json` (identifier only)

To decrypt the credentials file, Skygent resolves the credentials key in this order:

1. Environment: `SKYGENT_CREDENTIALS_KEY`
2. Keyfile: `<storeRoot>/credentials.key`

If a credentials file exists but no key is available, the CLI will error.

## Encrypted credentials file

- Path: `<storeRoot>/credentials.json`
- Encryption: AES-GCM with a key derived from the credentials key (env or keyfile)

You can create or update this file with:

```bash
skygent config credentials set --identifier handle.bsky.social --password app-password
```

Requires a credentials key (`SKYGENT_CREDENTIALS_KEY` or `<storeRoot>/credentials.key`).

## Credentials keyfile

To persist the credentials key across sessions, store it in:

- Path: `<storeRoot>/credentials.key`
- Format: Base64-encoded 32-byte key

You can manage the keyfile with:

```bash
skygent config credentials key set
skygent config credentials key status
skygent config credentials key clear
```

## Security model

- **Encrypted at rest:** `credentials.json` (only the identifier + password).
- **Plaintext at rest:** `config.json`, store databases, derived outputs, and cache files.
- **Filesystem permissions:** The CLI creates the store root and sensitive files with restrictive permissions (0700 for directories, 0600 for sensitive files) when possible.

## Password flag caution

Passing `--password` on the command line may be recorded in shell history. For automation, prefer environment variables or `config credentials set` in a protected shell session.

## Key rotation

1. Set a new credentials key (`SKYGENT_CREDENTIALS_KEY` or `config credentials key set`).
2. Re-save credentials with the new key:

```bash
skygent config credentials set --identifier handle.bsky.social --password app-password
```

If you no longer have the old key, delete `<storeRoot>/credentials.json` and re-save credentials.

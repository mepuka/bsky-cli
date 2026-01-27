# Configuration

Skygent loads configuration in this order (last wins):

1. Defaults
2. Global config file
3. Environment variables
4. CLI overrides

## Global config file

Location:

- Default: `~/.skygent/config.json`

Note: the config file is currently always read from the default location above,
even if `SKYGENT_STORE_ROOT` or `--store-root` is set.

Supported fields:

```json
{
  "service": "https://bsky.social",
  "storeRoot": "/absolute/path/to/.skygent",
  "outputFormat": "ndjson",
  "identifier": "user.bsky.social"
}
```

Notes:

- `storeRoot` is normalized to an absolute path; `~` is expanded.
- `outputFormat` defaults to `ndjson` and is used by `query` when `--format` is not provided.

## Environment variables

Core:

- `SKYGENT_SERVICE`
- `SKYGENT_STORE_ROOT`
- `SKYGENT_OUTPUT_FORMAT`
- `SKYGENT_IDENTIFIER`
- `SKYGENT_PASSWORD`
- `SKYGENT_CREDENTIALS_KEY`

Bluesky rate limiting:

- `SKYGENT_BSKY_RATE_LIMIT`
- `SKYGENT_BSKY_RETRY_BASE`
- `SKYGENT_BSKY_RETRY_MAX`

Resource monitoring:

- `SKYGENT_RESOURCE_CHECK_INTERVAL`
- `SKYGENT_RESOURCE_STORE_WARN_BYTES`
- `SKYGENT_RESOURCE_RSS_WARN_BYTES`

LLM settings (providers, cache, models, etc) are also supported. See `.env.example` for the full list.

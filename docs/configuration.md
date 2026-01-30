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

Jetstream profile resolution:

- `SKYGENT_PROFILE_BATCH_SIZE`
- `SKYGENT_PROFILE_CACHE_CAPACITY`
- `SKYGENT_PROFILE_CACHE_TTL`

Resource monitoring:

- `SKYGENT_RESOURCE_CHECK_INTERVAL`
- `SKYGENT_RESOURCE_STORE_WARN_BYTES`
- `SKYGENT_RESOURCE_RSS_WARN_BYTES`

Sync settings:

- `SKYGENT_SYNC_CONCURRENCY` -- number of concurrent sync operations. Must be a positive integer. Default: `5`.
- `SKYGENT_SYNC_CHECKPOINT_EVERY` -- persist a checkpoint after this many ingested items. Must be a positive integer. Default: `100`.
- `SKYGENT_SYNC_CHECKPOINT_INTERVAL_MS` -- minimum milliseconds between time-based checkpoints. Must be non-negative. Default: `5000`.

Filter settings:

- `SKYGENT_FILTER_CONCURRENCY` -- number of concurrent filter evaluations per batch. Must be a positive integer. Default: `10`.

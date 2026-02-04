---
"@mepuka/skygent": minor
---

### New Commands

- **`actor resolve`**: Resolve DIDs to handles and vice versa with cache support
- **`capabilities`**: Machine-readable feature discovery for agents (filters, formats, commands)

### CLI Ergonomics

- **Dual store syntax**: All commands now accept both positional `<store>` and `--store` flag
- **`--filter-help`**: Inline filter predicate reference on query commands
- **Bulk source addition**: `--authors-file` and multiple `--author` flags for batch operations
- **Better errors**: Improved messages for global flag positioning issues

### Output & Formatting

- **`SKYGENT_OUTPUT_FORMAT`**: Environment variable for default output format
- **Structured errors**: Machine-readable error envelope with codes for agent parsing
- **Consistent formats**: Standardized format resolution across all commands

### Agent Safety

- **`--dry-run`**: Preview sync, delete, and destructive operations before execution
- **Idempotent operations**: Explicit `action` field (created/updated/unchanged) in responses
- **Sync progress**: Enhanced feedback with source-level tracking and counts

### Analysis UX

- **Graph summaries**: Interaction breakdowns (reply/quote/mention/repost) in graph output
- **Community labels**: Auto-generated labels using central member handles
- **Store descriptions**: `--description` flag on `store create`
- **Link filtering**: New `link-contains` predicate for URL content filtering

### Bug Fixes

- Handle -1 metric values from Bluesky API
- Fix sync command help text examples
- Add `search users` alias for handle search

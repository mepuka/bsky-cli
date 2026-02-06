---
"@mepuka/skygent": patch
---

Fix credential resolution order: overrides and env vars now take priority over file, and corrupt credential files no longer block the fallback chain. Rename `credentials set` flags to `--id`/`--pw` to avoid clash with root command global options.

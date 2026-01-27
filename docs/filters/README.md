# Filter Guide

Filters are used to select posts in two different contexts:

- **Sync/query filters**: passed via `--filter` / `--filter-json` to `sync`, `query`, and `watch`. These run at ingestion or query time.
- **Store config filters**: stored in `StoreConfig.filters` and materialized via `store materialize`. These produce saved outputs (views) on disk.

Named filters (`skygent filter create`) can be referenced in the DSL with `@name`.

## Quick start

DSL:

```
skygent sync timeline --store tech --filter 'hashtag:#tech AND engagement:minLikes=50'
```

JSON:

```
skygent sync timeline --store tech --filter-json '{"_tag":"Hashtag","tag":"#tech"}'
```

## Contents

- `reference.md` - full filter syntax reference (JSON + DSL)
- `performance.md` - performance characteristics and best practices
- `examples.md` - common filter patterns
- `testing.md` - validate/test/describe/explain/benchmark commands

## Sync vs store config filters

Sync/query filters control **what gets ingested or returned**. Store config filters control **what gets materialized to disk**. They are related but distinct:

- Sync/query: `--filter` / `--filter-json`
- Store config: `StoreConfig.filters[]` + `store materialize`

# Full CLI Surface Coverage Test Plan

> Generated 2026-01-29. Execute each phase, then append findings to `full-surface-notes.md`.

## Phase 1 — Config & Health

```bash
skygent config check
```

**Check:** exits 0, reports store root / creds / auth OK.

---

## Phase 2 — Store Lifecycle

```bash
skygent store list
skygent store create test-coverage
skygent store list
skygent store show test-coverage
skygent store stats test-coverage
skygent store summary
skygent store tree
skygent store tree --format table
skygent store tree --format json
skygent store tree --ansi
skygent store tree --width 60
skygent store delete test-coverage          # should prompt
skygent store delete test-coverage --force  # should succeed
skygent store list                          # confirm gone
```

---

## Phase 3 — Sync: All 7 Sources

```bash
skygent store create sync-test

# timeline
skygent sync timeline --store sync-test

# feed (discover feed)
skygent sync feed at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot --store sync-test

# list
skygent sync list at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.graph.list/3jxsc5bop3c2a --store sync-test

# notifications
skygent sync notifications --store sync-test

# author
skygent sync author bsky.app --store sync-test

# thread (use a known post URI)
skygent sync thread at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --store sync-test

# jetstream (bounded)
skygent sync jetstream --store sync-test --duration "5 seconds" --limit 50

skygent store stats sync-test
```

---

## Phase 4 — Sync Flags

```bash
skygent store create flag-test

# --quiet
skygent sync timeline --store flag-test --quiet

# --refresh
skygent sync timeline --store flag-test --refresh

# --filter (DSL)
skygent sync timeline --store flag-test --filter "has:images"

# --post-filter (author only)
skygent sync author bsky.app --store flag-test --post-filter "has:images"
```

---

## Phase 5 — Watch Mode

```bash
skygent store create watch-test

# Watch timeline for ~15 seconds then Ctrl-C
skygent watch timeline --store watch-test --interval "10 seconds"

# Watch jetstream for ~10 seconds then Ctrl-C
skygent watch jetstream --store watch-test
```

**Check:** graceful shutdown on SIGINT, checkpoint written.

---

## Phase 6 — Query: All Formats & Flags

```bash
# Ensure sync-test has data (from phase 3)
skygent query sync-test --limit 3 --format json
skygent query sync-test --limit 3 --format ndjson
skygent query sync-test --limit 3 --format markdown
skygent query sync-test --limit 3 --format table
skygent query sync-test --limit 3 --format compact
skygent query sync-test --limit 3 --format card
skygent query sync-test --limit 3 --format card --ansi
skygent query sync-test --limit 3 --format card --width 60
skygent query sync-test --limit 3 --format thread

# sort / newest-first
skygent query sync-test --limit 3 --sort desc --format compact
skygent query sync-test --limit 3 --newest-first --format compact

# fields
skygent query sync-test --limit 3 --fields @minimal --format json
skygent query sync-test --limit 3 --fields @social --format json
skygent query sync-test --limit 3 --fields @full --format json
skygent query sync-test --limit 3 --fields "author.handle,text" --format json

# range
skygent query sync-test --range "2025-01-01..2026-02-01" --limit 3 --format compact

# filter
skygent query sync-test --filter "has:images" --limit 3 --format compact

# progress
skygent query sync-test --filter "has:images" --limit 3 --progress --format compact

# scan-limit
skygent query sync-test --scan-limit 10 --format compact
```

---

## Phase 7 — Filter CRUD

```bash
skygent filter create test-img --filter "has:images"
skygent filter list
skygent filter show test-img
skygent filter validate --filter "has:images"
skygent filter validate --filter "bogus:::bad"
skygent filter validate-all
skygent filter delete test-img
skygent filter list
```

---

## Phase 8 — Filter DSL Exhaustive

```bash
# Content predicates
skygent filter validate --filter 'has:images'
skygent filter validate --filter 'has:video'
skygent filter validate --filter 'has:links'
skygent filter validate --filter 'has:embed'
skygent filter validate --filter 'has:media'
skygent filter validate --filter 'has:reply'
skygent filter validate --filter 'has:quote'

# Text matching
skygent filter validate --filter 'text:contains "hello"'
skygent filter validate --filter 'text:matches "^hello"'

# Language
skygent filter validate --filter 'lang:en'
skygent filter validate --filter 'lang:ja'

# Labels
skygent filter validate --filter 'label:nsfw'

# Author
skygent filter validate --filter 'from:bsky.app'

# Boolean combinators
skygent filter validate --filter 'has:images AND has:links'
skygent filter validate --filter 'has:images OR has:video'
skygent filter validate --filter 'NOT has:reply'
skygent filter validate --filter '(has:images OR has:video) AND NOT has:reply'
```

---

## Phase 9 — Filter Analysis

```bash
# describe
skygent filter describe --filter "has:images AND NOT has:reply"
skygent filter describe --filter "has:images AND NOT has:reply" --format json
skygent filter describe --filter "has:images AND NOT has:reply" --ansi

# test (need a real post URI)
skygent filter test --filter "has:images" --post-uri "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a"
skygent filter test --filter "has:images" --post-uri "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a" --format json

# explain
skygent filter explain --filter "has:images" --post-uri "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a"

# benchmark
skygent filter benchmark --filter "has:images" --store sync-test
skygent filter benchmark --filter "has:images" --store sync-test --sample-size 50
```

---

## Phase 10 — Derivation

```bash
skygent store create derive-source
skygent sync timeline --store derive-source --quiet

# EventTime derive
skygent derive derive-source derive-et --filter "has:images"

# DeriveTime derive
skygent derive derive-source derive-dt --filter "has:images" --mode derive-time

# Check staleness
skygent view status derive-et derive-source
skygent view status derive-dt derive-source

# Incremental: add more data, re-derive
skygent sync timeline --store derive-source --quiet --refresh
skygent derive derive-source derive-et --filter "has:images"
skygent view status derive-et derive-source

# Reset
skygent derive derive-source derive-et --filter "has:images" --reset --yes

# view thread
skygent view thread at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a
skygent view thread at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --compact
skygent view thread at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --ansi
skygent view thread at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --format json
```

---

## Phase 11 — Search

```bash
# handles
skygent search handles "bsky" --limit 5
skygent search handles "bsky" --limit 5 --format table
skygent search handles "bsky" --typeahead --limit 5

# users (alias for handles)
skygent search users "bsky" --limit 5

# feeds
skygent search feeds "news" --limit 5
skygent search feeds "news" --limit 5 --format table

# posts (network)
skygent search posts "bluesky" --network --limit 5
skygent search posts "bluesky" --network --limit 5 --sort top
skygent search posts "bluesky" --network --limit 5 --sort latest
skygent search posts "bluesky" --network --limit 5 --lang en
skygent search posts "bluesky" --network --limit 5 --author bsky.app

# posts (local)
skygent search posts "the" --store sync-test --limit 5
skygent search posts "the" --store sync-test --limit 5 --sort relevance
skygent search posts "the" --store sync-test --limit 5 --sort newest
```

---

## Phase 12 — Graph

```bash
skygent graph followers bsky.app --limit 5
skygent graph followers bsky.app --limit 5 --format table

skygent graph follows bsky.app --limit 5
skygent graph follows bsky.app --limit 5 --format table

skygent graph known-followers bsky.app --limit 5

skygent graph relationships bsky.app --others "pfrazee.com,jay.bsky.team"

skygent graph lists bsky.app --limit 5
skygent graph lists bsky.app --limit 5 --purpose curatelist

skygent graph blocks --limit 5
skygent graph mutes --limit 5
```

---

## Phase 13 — Feed Discovery

```bash
skygent feed show at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot
skygent feed show at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot --format table

skygent feed batch at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/with-friends
skygent feed batch at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/with-friends --format table

skygent feed by bsky.app --limit 5
skygent feed by bsky.app --limit 5 --format table
```

---

## Phase 14 — Post Engagement

```bash
skygent post likes at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --limit 5
skygent post likes at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --limit 5 --format table

skygent post reposted-by at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --limit 5

skygent post quotes at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3jwdojnbe6s2a --limit 5
```

---

## Phase 15 — Error & Edge Cases

```bash
# Non-existent store
skygent query nonexistent --limit 1
skygent store show nonexistent
skygent store delete nonexistent --force

# Invalid filter
skygent query sync-test --filter "bogus:::bad" --limit 1

# Invalid URI
skygent sync feed invalid-uri --store sync-test
skygent sync thread invalid-uri --store sync-test

# Missing required args
skygent sync timeline
skygent derive
skygent filter test

# Global flags
skygent query sync-test --limit 1 --output-format json
skygent query sync-test --limit 1 --log-format json
skygent query sync-test --limit 1 --compact
```

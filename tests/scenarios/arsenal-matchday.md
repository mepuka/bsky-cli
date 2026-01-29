# Arsenal Match-Day Monitoring Scenario

**Date:** 2026-01-28
**Purpose:** End-to-end CLI integration test modeling an agent monitoring Arsenal match discussion on Bluesky.

---

## Phase 1: Health Check & Store Setup

```bash
skygent config check
skygent store create arsenal-matchday
skygent store list
```

- [ ] Config check passes
- [ ] Store created successfully
- [ ] Store appears in list

---

## Phase 2: Ingest Data — Multiple Sources

### 2a. Author sync — Arsenal-related accounts
```bash
skygent sync author arsenal.bsky.social --store arsenal-matchday --quiet
skygent sync author premierleague.bsky.social --store arsenal-matchday --quiet
```

### 2b. Jetstream burst — firehose capture
```bash
skygent sync jetstream --store arsenal-matchday --limit 1000 --filter 'contains:"Arsenal" OR contains:"Gunners" OR hashtag:#AFC' --quiet
```

### 2c. Thread sync — grab a match thread once discovered
```bash
# URI populated after Phase 4 exploration
skygent sync thread <thread-uri> --store arsenal-matchday --depth 30 --quiet
```

- [ ] Author sync completes with posts ingested
- [ ] Jetstream captures live posts
- [ ] Thread sync captures full conversation

---

## Phase 3: Saved Filters — Comprehensive Library

### Content & hashtag filters
```bash
skygent filter create arsenal-core --filter 'hashtag:#Arsenal OR hashtag:#AFC OR hashtag:#Gunners OR hashtag:#COYG'
skygent filter create arsenal-match --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND (contains:"match" OR contains:"game" OR contains:"kickoff" OR contains:"halftime" OR contains:"fulltime")'
```

### Goal & scoring filters
```bash
skygent filter create arsenal-goals --filter '(hashtag:#Arsenal OR contains:"Arsenal") AND (contains:"goal" OR contains:"scored" OR contains:"equalizer" OR contains:"winner")'
skygent filter create arsenal-scoreline --filter 'regex:/\b(Arsenal|AFC|Gunners)\b.*\b\d+-\d+\b/i'
```

### Regex filters — tactical & player discussion
```bash
skygent filter create arsenal-formation --filter 'regex:/\b(4-[23]-[31]|3-[45]-[21]|back\s*(three|four|five))\b/i AND (contains:"Arsenal" OR hashtag:#Arsenal)'
skygent filter create arsenal-players --filter 'regex:/\b(Saka|Saliba|Rice|Odegaard|Havertz|Raya|Timber|Trossard|Martinelli|Jesus|Calafiori|Merino|Nwaneri)\b/i'
skygent filter create arsenal-xg --filter 'regex:/\bx[Gg]\b|\bexpected\s*goals?\b/i AND (contains:"Arsenal" OR hashtag:#Arsenal)'
skygent filter create arsenal-var --filter 'regex:/\b(VAR|offside|penalty|red\s*card|yellow\s*card|foul|handball)\b/i AND (contains:"Arsenal" OR hashtag:#Arsenal)'
skygent filter create arsenal-emotions --filter 'regex:/\b(COYG|come\s*on|let.s\s*go|inject|massive|gutted|fuming|scenes|limbs)\b/i AND hashtag:#Arsenal'
```

### Media & engagement filters
```bash
skygent filter create arsenal-highlights --filter '(hashtag:#Arsenal OR hashtag:#AFC) AND (hasimages OR hasvideo)'
skygent filter create arsenal-viral --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND engagement:minLikes=50'
skygent filter create arsenal-hot-takes --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND engagement:minLikes=100,minReposts=20'
```

### Post-type filters
```bash
skygent filter create arsenal-threads --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND is:reply'
skygent filter create arsenal-originals --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND is:original'
skygent filter create arsenal-quotes --filter '(contains:"Arsenal" OR hashtag:#Arsenal) AND is:quote'
```

### Validation & describe
```bash
skygent filter validate-all
skygent filter list
skygent filter describe --filter '@arsenal-formation' --ansi
skygent filter describe --filter '@arsenal-scoreline' --ansi
skygent filter describe --filter '@arsenal-players' --format json
```

- [ ] All filters created
- [ ] validate-all reports 0 failures
- [ ] Describe renders styled output with --ansi

---

## Phase 4: Deep Exploration — Query & Discover

### 4a. Initial survey — what did we capture?
```bash
skygent store stats arsenal-matchday
skygent query arsenal-matchday --format compact --ansi --limit 50
```

### 4b. Find interesting posts & threads
```bash
# Most engaged posts
skygent query arsenal-matchday --filter 'engagement:minLikes=10' --format card --ansi --limit 20

# Goal moments
skygent query arsenal-matchday --filter 'regex:/\b(goal|scored|GOAL)\b/i' --format card --ansi

# Scoreline mentions
skygent query arsenal-matchday --filter 'regex:/\b\d+-\d+\b/' --format compact --ansi --limit 30

# Player mentions with engagement
skygent query arsenal-matchday --filter 'regex:/\b(Saka|Rice|Odegaard|Saliba)\b/i AND engagement:minLikes=5' --format card --ansi

# VAR/referee controversy
skygent query arsenal-matchday --filter 'regex:/\b(VAR|referee|ref|pen(alty)?|offside)\b/i' --format card --ansi --limit 15

# Tactical discussion
skygent query arsenal-matchday --filter 'regex:/\b(formation|tactic|press|midfield|defend|attack|wing)\b/i AND (contains:"Arsenal" OR contains:"Arteta")' --format compact --ansi

# xG nerds
skygent query arsenal-matchday --filter 'regex:/\bx[Gg]\b|\bexpected goals\b/i' --format card --ansi

# Emotional pulse
skygent query arsenal-matchday --filter 'regex:/\b(COYG|scenes|limbs|inject|massive)\b/i' --format compact --ansi --limit 20
```

### 4c. Time-sliced exploration
```bash
# Pre-match buzz (assuming ~15:00 kickoff)
skygent query arsenal-matchday --range 2026-01-28T13:00:00Z..2026-01-28T15:00:00Z --format compact --ansi --limit 20

# First half
skygent query arsenal-matchday --range 2026-01-28T15:00:00Z..2026-01-28T15:50:00Z --format card --ansi

# Halftime reactions
skygent query arsenal-matchday --range 2026-01-28T15:45:00Z..2026-01-28T16:05:00Z --format compact --ansi

# Second half
skygent query arsenal-matchday --range 2026-01-28T16:05:00Z..2026-01-28T17:00:00Z --format card --ansi

# Post-match analysis
skygent query arsenal-matchday --range 2026-01-28T17:00:00Z..2026-01-28T20:00:00Z --format compact --ansi --limit 30
```

### 4d. Author-specific deep dives
```bash
# What did the official account post?
skygent query arsenal-matchday --filter 'author:arsenal.bsky.social' --format card --ansi

# Find most prolific posters
skygent query arsenal-matchday --format json --fields author --limit 200 | bun -e "
  const posts = JSON.parse(await Bun.stdin.text());
  const counts = {};
  for (const p of posts) counts[p.author] = (counts[p.author] || 0) + 1;
  console.log(JSON.stringify(Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,10), null, 2));
"
```

### 4e. Thread exploration
```bash
# Find posts with most replies (likely threads)
skygent query arsenal-matchday --filter 'engagement:minReplies=5' --format card --ansi

# Dive into a discovered thread
skygent view thread <discovered-uri> --ansi
skygent view thread <discovered-uri> --compact --ansi --width 80
skygent view thread <discovered-uri> --format json
```

### 4f. Cross-format comparison
```bash
# Same data, different views
skygent query arsenal-matchday --limit 5 --format json
skygent query arsenal-matchday --limit 5 --format table
skygent query arsenal-matchday --limit 5 --format markdown
skygent query arsenal-matchday --limit 5 --format compact --ansi
skygent query arsenal-matchday --limit 5 --format card --ansi
skygent query arsenal-matchday --limit 5 --format card --width 60
skygent query arsenal-matchday --limit 5 --format thread --ansi
skygent query arsenal-matchday --limit 5 --format compact  # no --ansi = plain
```

- [ ] Stats show ingested post count
- [ ] Regex filters match real content
- [ ] Time-sliced queries return appropriate windows
- [ ] All format variants render without error
- [ ] --ansi produces escape codes, plain does not
- [ ] --width constrains output width

---

## Phase 5: Derived Views — Build the Analysis Pipeline

```bash
skygent derive arsenal-matchday arsenal-goals-view --filter '@arsenal-goals'
skygent derive arsenal-matchday arsenal-players-view --filter '@arsenal-players'
skygent derive arsenal-matchday arsenal-scorelines --filter '@arsenal-scoreline'
skygent derive arsenal-matchday arsenal-media-view --filter '@arsenal-highlights'
skygent derive arsenal-matchday arsenal-viral-view --filter '@arsenal-viral'
skygent derive arsenal-matchday arsenal-var-view --filter '@arsenal-var'
skygent derive arsenal-matchday arsenal-emotions-view --filter '@arsenal-emotions'
skygent derive arsenal-matchday arsenal-tactical --filter '@arsenal-formation'
```

### Lineage visualization
```bash
skygent store tree --ansi
skygent store tree --format table
skygent store tree --format json
skygent store summary
```

### Freshness checks
```bash
skygent view status arsenal-goals-view arsenal-matchday
skygent view status arsenal-players-view arsenal-matchday
skygent view status arsenal-viral-view arsenal-matchday
```

### Query derived views
```bash
skygent query arsenal-goals-view --format card --ansi
skygent query arsenal-players-view --format compact --ansi --limit 20
skygent query arsenal-scorelines --format card --ansi
skygent query arsenal-var-view --format card --ansi
skygent query arsenal-emotions-view --format compact --ansi --limit 30
skygent query arsenal-tactical --format card --ansi
skygent query arsenal-viral-view --format card --ansi --width 120
```

- [ ] All derivations complete
- [ ] Store tree shows full DAG
- [ ] View status reports ready for all derived stores
- [ ] Derived view queries return filtered subsets

---

## Phase 6: Thread Deep-Dive

```bash
# From API (requires auth)
skygent view thread <popular-post-uri> --ansi
skygent view thread <popular-post-uri> --compact --ansi
skygent view thread <popular-post-uri> --ansi --width 100
skygent view thread <popular-post-uri> --format json
skygent view thread <popular-post-uri> --depth 3 --ansi

# From store
skygent view thread <post-uri-in-store> --store arsenal-matchday --ansi
skygent view thread <post-uri-in-store> --store arsenal-matchday --compact --ansi
```

- [ ] API thread fetches and renders
- [ ] Store-based thread renders
- [ ] Compact vs card mode visually distinct
- [ ] JSON output valid

---

## Phase 7: Filter Analysis & Benchmarking

```bash
# Describe filters with styled output
skygent filter describe --filter '@arsenal-core' --ansi
skygent filter describe --filter '@arsenal-formation' --ansi
skygent filter describe --filter '@arsenal-scoreline' --ansi
skygent filter describe --filter '@arsenal-players' --ansi
skygent filter describe --filter '@arsenal-var' --ansi
skygent filter describe --filter '@arsenal-emotions' --format json

# Test individual posts against filters
skygent filter test --filter '@arsenal-goals' --post-uri <goal-post-uri>
skygent filter test --filter '@arsenal-var' --post-uri <var-post-uri>
skygent filter explain --filter '@arsenal-goals' --post-uri <goal-post-uri>
skygent filter explain --filter '@arsenal-players' --post-uri <player-post-uri>

# Benchmark filter performance
skygent filter benchmark --store arsenal-matchday --filter '@arsenal-core' --sample-size 500
skygent filter benchmark --store arsenal-matchday --filter '@arsenal-players' --sample-size 500
skygent filter benchmark --store arsenal-matchday --filter '@arsenal-scoreline' --sample-size 500
skygent filter benchmark --store arsenal-matchday --filter '@arsenal-formation' --sample-size 500
```

- [ ] Describe renders styled Doc output with --ansi
- [ ] Filter test returns match/no-match correctly
- [ ] Filter explain shows reasoning
- [ ] Benchmarks complete with timing data

---

## Phase 8: Export & Materialize

```bash
skygent store materialize arsenal-matchday
skygent store stats arsenal-matchday
skygent store stats arsenal-goals-view
skygent store stats arsenal-viral-view
skygent store summary --compact
```

- [ ] Materialize writes configured outputs
- [ ] Stats reflect accurate counts across all stores

---

## Phase 9: Cleanup (optional)

```bash
skygent store delete arsenal-emotions-view --force
skygent store delete arsenal-tactical --force
skygent store tree --ansi  # verify pruned
```

---

## Regex Filter Coverage

| Filter | Pattern | Tests |
|--------|---------|-------|
| arsenal-scoreline | `\b(Arsenal\|AFC\|Gunners)\b.*\b\d+-\d+\b` | "Arsenal 2-1", "AFC won 3-0" |
| arsenal-formation | `\b(4-[23]-[31]\|3-[45]-[21]\|back\s*(three\|four\|five))\b` | "4-3-3", "back four" |
| arsenal-players | `\b(Saka\|Saliba\|Rice\|...)\b` | Player name mentions |
| arsenal-xg | `\bx[Gg]\b\|\bexpected\s*goals?\b` | "xG of 2.1", "expected goals" |
| arsenal-var | `\b(VAR\|offside\|penalty\|...)\b` | "VAR check", "penalty shout" |
| arsenal-emotions | `\b(COYG\|scenes\|limbs\|...)\b` | "COYG!", "absolute scenes" |

---

## New Feature Coverage

| Feature | Phase | Commands |
|---------|-------|----------|
| `--format compact` | 4a, 4b, 4c, 4f, 5 | query with compact rendering |
| `--format card` | 4b, 4f, 5 | query with card rendering |
| `--format thread` | 4f | query with thread tree |
| `--ansi` | 3, 4-7 | Throughout all Doc-based output |
| `--width` | 4f, 5, 6 | Width-constrained rendering |
| `view thread` (API) | 6 | Thread fetch + render |
| `view thread` (store) | 6 | Store-based thread render |
| `filter describe --ansi` | 3, 7 | Styled filter description |

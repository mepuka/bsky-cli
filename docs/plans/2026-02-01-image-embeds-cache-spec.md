# Image Embeds, Extraction, and Persisted Cache Spec (2026-02-01)

Goal: deliver an Effect-native system for image/embed indexing, extraction, rendering, and local caching that addresses issues #135-#138.

Status: in progress (core extraction/rendering/indexing implemented; cache cleanup + docs/tests/FTS alt-text pushdown pending).

## Scope (issues)

- #135 Index image count and alt text for filtering
- #136 Add image/embed extraction to query output
- #137 Local image caching and archival
- #138 Render image embeds in card and terminal output

## Goals

1) Queryable image metadata with SQL pushdown.
2) Agent-friendly outputs for embeds and images.
3) Terminal renderers that surface embed context.
4) Local cache + archive with TTL and opt-in behavior.
5) Idiomatic Effect layering and typed errors.

## Non-goals

- Video caching in the first iteration.
- Image transforms beyond optional thumbnail download.
- Remote storage backends (S3/GCS) in this phase.

## Effect-native constraints (tight patterns)

- Domain stays pure (Schema, branded primitives, no service deps).
- Services are Context.Tag with static `layer`, and operations named via `Effect.fn`.
- Layer composition uses `Layer.mergeAll` + `Layer.provideMerge`.
- Caching uses `RequestResolver.persisted` for metadata and `FileSystem` for bytes.
- Errors are `Schema.TaggedError` and mapped at service boundaries.

## Current state (relevant)

- Embeds modeled in `src/domain/bsky.ts` (`EmbedImages`, `EmbedVideo`, `EmbedExternal`).
- Image extraction + summaries in `src/domain/embeds.ts` + `src/domain/images.ts`.
- Store index includes `image_count`, `alt_text`, `has_alt_text` with migration 008.
- Filter DSL/runtime supports `min-images`, `alt-text`, `no-alt-text`, `has:alt-text`.
- Compact output includes `embedSummary`; card/table/thread render embed summaries.
- Query supports `@images`, `@embeds`, `@media`, `--extract-images`, `--resolve-images`, `--cache-images`.
- Image cache stack implemented (fetcher, archive, persisted metadata cache, CLI commands, sync/watch/query flags).

## Data model and extraction

Add domain types and pure extraction helpers:

- `src/domain/images.ts`
  - `ImageRef`: `{ fullsizeUrl, thumbUrl, alt?, aspectRatio? }`
  - `ImageSummary`: `{ imageCount, hasAltText, thumbnailUrl? }`
  - `EmbedSummary`: `{ type, imageSummary?, external?, record? }`

- `src/domain/embeds.ts` (new or extend existing)
  - `extractImageRefs(embed: PostEmbed): ReadonlyArray<ImageRef>`
  - `summarizeEmbed(embed: PostEmbed): EmbedSummary`

Design notes:
- Extraction is deterministic and side-effect free.
- `recordWithMedia` embeds must be flattened into the same image list.

## Indexing and filter DSL (#135)

### Columns

Add to `posts` table:
- `image_count INTEGER NOT NULL DEFAULT 0`
- `alt_text TEXT NOT NULL DEFAULT ''` (concatenated alt text)
- `has_alt_text INTEGER NOT NULL DEFAULT 0`

### FTS changes

Rebuild `posts_fts` to include alt text as a separate column:
- `posts_fts(text, alt_text, content='posts', content_rowid='rowid')`
- Triggers insert `new.text` and `new.alt_text`.

Rationale: `alt-text:` queries should target alt text only, without conflating with post body.

### Derived values

- `image_count`: count of images in `EmbedImages` (including `recordWithMedia`).
- `alt_text`: join all non-empty alt values with `\n`.
- `has_alt_text`: `image_count > 0 && all images have alt text`.

### Filter DSL additions

- `min-images:N` -> `image_count >= N`
- `has:alt-text` -> `has_alt_text = 1`
- `no-alt-text` -> `image_count > 0 AND has_alt_text = 0`
- `alt-text:pattern` -> FTS on `posts_fts.alt_text` or runtime fallback

### SQL pushdown

- Push down `min-images`, `has:alt-text`, `no-alt-text`.
- For `alt-text:pattern`:
  - Plain text -> `posts_fts MATCH` on `alt_text` column.
  - Regex-like -> runtime filter.

### Migration/backfill

- Migration adds columns, rebuilds FTS, and backfills from `post_json`.
- Backfill uses the same extraction helpers as the live indexer.
- Rebuild FTS after backfill to ensure consistent indexing.

## Output + extraction (#136)

### Compact output

Add `embedSummary` to compact JSON:

```
{
  "type": "images" | "video" | "external" | "record" | "record_with_media" | "unknown",
  "imageSummary": { "imageCount": number, "hasAltText": boolean, "thumbnailUrl"?: string } | undefined,
  "external": { "uri": string, "title"?: string, "description"?: string, "thumb"?: string } | undefined,
  "record": { "uri"?: string, "authorHandle"?: string } | undefined
}
```

### Field presets

- `@images`: `uri, author, text, createdAt, images[] { fullsizeUrl, thumbUrl, alt, aspectRatio }`
- `@embeds`: `uri, author, text, createdAt, embedSummary`
- `@media`: includes `images` + `embedSummary`

### Extract mode

Add `query --extract-images`:
- Emits one record per image: `{ postUri, author, imageUrl, thumbUrl, alt, aspectRatio }`.
- Works with `json`, `ndjson`, and `table` output.

Integration points:
- `src/cli/compact-output.ts`
- `src/cli/query-fields.ts`
- `src/cli/query.ts`
- `src/domain/format.ts` (table/markdown columns)

## Terminal rendering (#138)

- Implemented:
  - Card + thread: embed summaries + details in `src/cli/doc/post.ts`.
  - Table/markdown: embed summary column in `src/domain/format.ts`.
  - ANSI styling in `src/cli/doc/annotation.ts`.

Integration points:
- `src/cli/doc/post.ts`
- `src/cli/doc/annotation.ts`
- `src/domain/format.ts`

## Caching + archival (#137)

### Strategy

- Persisted metadata cache using `@effect/experimental/PersistedCache`.
- Byte storage via `FileSystem` under store root.
- Keep experimental API surface isolated in `src/services/images/*`.

### Request-level batching

- `ImageFetcher` uses `RequestResolver` to batch concurrent fetches.
- Optional `@effect/experimental/RequestResolver.dataLoader` window coalesces bursts.
- In-flight request caching uses `Request.makeCache` + `Effect.withRequestCaching(true)`.

Suggested env knobs:
- `SKYGENT_IMAGE_FETCH_CONCURRENCY`
- `SKYGENT_IMAGE_FETCH_BATCH_WINDOW`
- `SKYGENT_IMAGE_FETCH_BATCH_SIZE`
- `SKYGENT_IMAGE_REQUEST_CACHE_CAPACITY`
- `SKYGENT_IMAGE_REQUEST_CACHE_TTL`

### Persisted metadata cache

- Keys: `ImageCacheRequest` (Schema.TaggedRequest + PrimaryKey).
- Values: `ImageAsset` (path, contentType, size, dimensions, cachedAt).
- TTL: configurable; short TTL for failures.
- Backing: `RequestResolver.persisted` + `Persistence.layerResultKeyValueStore` at `{store}/.image-cache/meta`.
- In-memory request cache via `Request.makeCache` for hot entries.

### Archive layout

- Cache root: `{store-root}/.image-cache/`.
- `original/<hash>.<ext>` and `thumb/<hash>.<ext>`.
- Hash can be CID, URL hash, or content hash (choose once; document).

### CLI commands

- `store cache <name> [--thumbnails] [--limit N]`
- `store cache-status <name> [--thumbnails] [--limit N]`
- `store cache-clean --force`
- `sync/watch ... --cache-images [--cache-images-mode new|full] [--cache-images-limit N]`
  - `new` (default) caches newly added posts after each cycle.
  - `full` runs a full-store scan once (sync: after run; watch: before streaming).
  - `--cache-images-limit` caps the number of posts scanned (mode-dependent; see below).

### Query integration

- `query --resolve-images`: rewrite URLs to local paths when cached.
- `query --cache-images`: opt-in fetch + cache during query (implies resolve).
- Flags require images to be in the output (`--extract-images` or `--fields` including `images`).
- Optional lazy caching during query (opt-in).
- Background caching during sync/watch (opt-in via `--cache-images`).

## Remaining work (updated)

### #135 Index image count and alt text for filtering
- Use FTS `alt_text` column for `alt-text:` pushdown (currently falls back to `instr` on `posts.alt_text`).
- Decide on backfill strategy for stores without full event logs (document dependency vs add backfill path).
- Update filter docs/help to include `min-images`, `alt-text`, `no-alt-text`, `has:alt-text`.

### #136 Image/embed extraction to query output
- Add tests for `--extract-images` in json/ndjson/table modes and `embedSummary` projection.
- Update README/query docs with new presets + flags.
- Clarify `--limit` semantics when `--extract-images` is active (or add a dedicated `--image-limit`).
- Document or extend field selectors for array subfields (e.g. `images.*.alt`).

### #137 Local image caching and archival
- Add cache integrity + cleanup: verify archive file existence on metadata hit, delete orphaned files on invalidate/TTL sweep.
- Add an archive ref-index (hash/path → refcount, lastAccessed) to prevent leaks with content-hash storage.
- Add `--cache-images-thumbnails` (or `--no-cache-images-thumbnails`) for sync/watch parity with store cache.
- Add tests for invalidation cleanup, missing-file status, and sweep behavior.

### #138 Render image embeds in card and terminal output
- Add tests for alt-text/detail rendering and record-with-media images.

## Services and layers

Services in `src/services/images/`:

- `ImageConfig` (Layer.effect): config values.
- `ImageFetcher`: HTTP fetch + size/type checks.
- `ImageArchive`: write bytes, return `ImageAsset`.
- `ImageCache`: wrapper around PersistedCache (in-memory TTL/capacity from config).
- `ImagePipeline`: orchestrates extraction -> cache -> archive; used by sync/watch and cache commands.

Layer assembly (in `src/cli/layers.ts`):
- `ImageConfig` merged into `CliLive`.
- Provide `KeyValueStore.layerFileSystem` at `{storeRoot}/.image-cache/meta` and `Persistence.layerResultKeyValueStore`.

## Configuration

Config precedence: CLI > env > config file > defaults.

Suggested env keys (current implementation):
- `SKYGENT_IMAGE_CACHE_ENABLED`
- `SKYGENT_IMAGE_CACHE_ROOT`
- `SKYGENT_IMAGE_CACHE_TTL`
- `SKYGENT_IMAGE_CACHE_FAILURE_TTL`
- `SKYGENT_IMAGE_CACHE_MEM_CAPACITY`
- `SKYGENT_IMAGE_CACHE_MEM_TTL`

## Error handling

Typed errors in `src/domain/errors.ts`:
- `ImageFetchError` { url, message, status? }
- `ImageArchiveError` { path, operation, message }
- `ImageCacheError` { key, message }

Map to CLI errors at service boundaries.

## Testing

- Domain: schema round-trips for `ImageRef`, `ImageSummary`, `EmbedSummary`.
- Store index: migration tests + filter pushdown tests.
- CLI: snapshot tests for compact output and card/table rendering.
- Cache: KeyValueStore memory layer + archive fixtures.

## Observability

- Debug logging for cache hits/misses and archive writes.
- `store cache-status` reports coverage and size.

## Phased implementation plan

### Phase 0: Foundations (domain + config)

- Add domain types + extractors.
- Add `ImageConfig` + CLI/env/config wiring.
- Unit tests for extraction/summarization.

### Phase 1: Indexing + filters (#135)

- Add columns + indexes and rebuild FTS.
- Update store-index derivation from `post_json`.
- Add filter DSL nodes + runtime + SQL pushdown.
- Backfill migration + tests.

### Phase 2: Output + extraction (#136)

- Add `embed_summary` to compact output.
- Add `@images`, `@embeds`, `@media` presets.
- Implement `query --extract-images`.
- Update docs/examples.

### Phase 3: Terminal rendering (#138)

- Update card render (counts + alt snippets).
- Add table embed column.
- Add ANSI thread placeholders for embeds.

### Phase 4: Cache + archival (#137)

- Implement `ImageArchive` service.
- Implement `ImageCache` with PersistedCache.
- Add cache CLI commands + query `--resolve-images`.
- Optional lazy/background caching.

### Phase 5: Hardening + docs

- Document eviction and default limits.
- Add guardrails for large stores and slow IO.
- Validate default cache paths and permissions.

## Open decisions

1) Hash choice for archive paths: CID vs URL hash vs content hash.
2) Default caching mode: thumbnails only vs fullsize opt-in.
3) Lazy caching default: off vs on for `query`.

## Review Findings (2026-02-01)

High
- Watch `--cache-images` rescans the entire store on every cycle when `postsAdded > 0`, causing repeated full-store scans and re-caching on large stores. (Mitigated via `--cache-images-mode`.)
- Query `--cache-images`/`--resolve-images` can silently no-op with `--fields @full` (selectors = none) and `--resolve-images` without `--fields`/`--extract-images` does nothing while still succeeding.

Medium
- Sync uses the sync `--limit` (posts) as the image-cache limit (images), which is a semantics mismatch.
- Query may fetch/resolve images even when selected fields do not include `images`, creating side effects without visible output.
- Query `--count` with `--extract-images` and cache flags can still fetch/cache images, making counts side-effectful.
- Query cache errors fail the entire command; watch cache errors are logged and ignored; sync cache errors fail the command. UX is inconsistent.
- Image cache layers initialize even when disabled (`SKYGENT_IMAGE_CACHE_ENABLED=false`), which can still create directories or fail on permissions.

Low
- `ImageCache.invalidate` clears persisted entries but not in-memory cache; stale entries can survive in-process.
- `ensureCachedMany` is unbounded concurrency; can spike memory/HTTP usage on large batches.
- `ImageFetcher` reads full body when `content-length` is missing, which can exceed `maxBytes` before detection.

## Recommended Query Semantics (draft)

1) `--resolve-images` / `--cache-images` should be valid only when images are part of output:
   - `--extract-images`, or
   - `--fields` includes `images` (including presets `@images`/`@media`).
   Otherwise return a `CliInputError` with guidance (e.g., “use --fields @images or --extract-images”).
2) Do not fetch/resolve images if the selected fields do not include `images`. Avoid hidden side effects.
3) `--cache-images` should be best-effort in queries: log warnings and keep original URLs on failures rather than failing the query.
4) `--count` should never trigger fetching or caching, even with cache flags.
5) Clarify `--limit` when `--extract-images` is used:
   - Prefer keeping `--limit` as “posts” everywhere and add an `--image-limit` for image output, or
   - Update help text to state that `--extract-images` applies `--limit` to images.

## Recommended Sync/Watch Semantics (final)

1) `--cache-images` is best-effort for sync/watch (log + continue), not fail a successful sync.
2) Default mode `new` caches only newly added posts after each cycle.
3) `--cache-images-mode full` runs a full-store scan once (sync: after the run; watch: before streaming) and then caches only new posts per cycle.
4) `--cache-images-limit` caps the number of posts scanned:
   - `new`: clamps to `postsAdded` (so `limit` never exceeds new posts).
   - `full`: applies directly as a cap; omitted means “scan all posts”.
5) `--cache-images-mode full` allows cache runs even when `postsAdded == 0`.

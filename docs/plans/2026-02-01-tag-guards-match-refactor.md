# Tag Guards + Match Refactor Spec (2026-02-01)

Goal: replace ad-hoc `_tag` checks and scattered union switches with Effect-idiomatic guards and `Match`-based pattern matching, reducing duplication and tightening type safety.

Status: in progress (guards added for embeds/errors/events; Match refactor pending).

## Why this matters

- Fewer hand-rolled `_tag` checks means fewer drift bugs when unions evolve.
- `Schema.is` / `Predicate.isTagged` provide consistent, typed refinements.
- `Match.tagsExhaustive` gives compile-time coverage for discriminated unions.
- Centralized match tables reduce duplication and improve readability.

## Principles

1) Prefer `Schema.is` for `Schema.TaggedClass` / `Schema.TaggedError` types.
2) Use `Predicate.isTagged` only when a schema is not available.
3) Replace large `_tag` switches with `Match.tagsExhaustive` where unions are total.
4) Use `Match.tags` + `Match.orElse` when intentionally partial.
5) Favor reusable match tables (`Match.typeTags` / `Match.valueTags`) for shared logic.

## Current progress (done)

- Embed guards and helpers:
  - `src/domain/bsky.ts`: `isEmbed*`, `isEmbedRecordView`, `isFeedReasonRepost`
  - `src/domain/embeds.ts`: `embedMedia`, `hasExternalEmbed`, `hasVideoEmbed`, `isQuoteEmbed`
  - Wired into `src/cli/doc/post.ts`, `src/services/filter-runtime.ts`, `src/services/store-index-sql.ts`, `src/services/bsky-client.ts`
- Error guards:
  - `src/domain/errors.ts`: `isImageFetchError`, `isImageArchiveError`, `isImageCacheError`, `isStoreIoError`
  - Wired into `src/services/images/image-fetcher.ts`, `src/services/images/image-cache.ts`, `src/services/store-stats.ts`
- Event guards:
  - `src/domain/events.ts`: `isPostUpsert`, `isPostDelete`
  - Wired into `src/services/store-writer.ts`, `src/services/store-index.ts`, `src/services/derivation-engine.ts`
- Misc:
  - `src/cli/graph.ts`: `Either.isRight`
  - `src/services/identity-resolver.ts`: `Exit.isFailure`
  - `src/services/filter-library.ts`: `Schema.is(SystemError)`

## High-value targets (Match refactor)

These are the most impactful `_tag` switches to convert to `Match`:

### Filter policies
- `src/services/filter-runtime.ts`: `withPolicy`, `explainPolicy`
- `src/services/filter-compiler.ts`
- `src/domain/filter-describe.ts`

### Filter expressions (AST)
- `src/services/filter-runtime.ts`: `buildPredicate`, `buildExplainer`
- `src/services/filter-compiler.ts`
- `src/domain/filter-describe.ts`
- `src/services/store-index.ts` (pushdown)
- `src/cli/query.ts` (unicode-insensitive contains check)

### Sync outcomes / sources
- `src/domain/sync.ts`
- `src/services/sync-engine.ts`
- `src/services/jetstream-sync.ts`

### CLI token parsing
- `src/cli/filter-dsl.ts`
- `src/cli/logging.ts` (warnings)

## Remaining `_tag` scans (informational)

Use `rg -n "_tag" src` to confirm remaining sites. After this pass, most remaining `_tag`
uses should be inside match tables or small, local unions.

## Match patterns (to standardize)

### Total union
```
const matchPolicy = Match.type<FilterErrorPolicy>().pipe(
  Match.tagsExhaustive({
    Include: () => ...,
    Exclude: () => ...,
    Retry: (policy) => ...
  })
);
```

### Partial with fallback
```
const matchExpr = Match.type<FilterExpr>().pipe(
  Match.tags({
    Hashtag: (expr) => ...,
    Author: (expr) => ...
  }),
  Match.orElse((expr) => ...)
);
```

### Reusable mapping function
```
const describeExpr = Match.typeTags<FilterExpr>()({
  Hashtag: (expr) => ...,
  Author: (expr) => ...
});
```

## Phased implementation plan

1) Convert `FilterErrorPolicy` switches to `Match.tagsExhaustive`.
2) Convert filter AST matchers to `Match`:
   - Begin with `filter-compiler` and `filter-describe` (pure mappings).
   - Then `filter-runtime` (effectful, but still structured).
3) Convert sync outcome/source switches to `Match`.
4) Convert CLI token parsing to `Match.tagsExhaustive`.
5) Sweep for residual `_tag` checks and replace with guards or match tables.

## Acceptance criteria

- No ad-hoc `_tag` comparisons for domain unions (except in match tables).
- Guard utilities centralized via `Schema.is` / `Predicate.isTagged`.
- Match tables are exhaustive for core unions (filters, outcomes, sources).
- Typecheck passes; tests remain green.

## Related

- GitHub issue #149: "Refactor: replace direct _tag checks with typed guards"

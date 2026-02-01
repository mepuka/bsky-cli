Default to using Bun instead of Node.js.

- `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>`
- Bun automatically loads .env — don't use dotenv.

## Project Overview

Skygent (`@mepuka/skygent`) is an Effect-based CLI for Bluesky monitoring. Syncs posts into local SQLite stores, derives filtered views, queries with a filter DSL.

- **Entry:** `index.ts` → `src/cli/app.ts` (13 subcommand groups)
- **Layers:** `src/cli/layers.ts` composes ~25 services into `CliLive`
- **Module boundaries (strict):** domain → services → cli (never reverse)

```
src/cli/        # Commands, options, output formatting, doc/ for ANSI rendering
src/domain/     # Pure types, schemas, errors (no service deps)
src/services/   # Effect services (Context.Tag pattern)
src/graph/      # Social graph algorithms
tests/          # cli/, domain/, services/, support/
.reference/     # Dev-only: effect/, effect-jetstream/, bsky-docs/
```

## Effect Conventions

Follow existing patterns — don't invent new ones. Check `effect-solutions show <topic>` for unfamiliar APIs.

**Services:** `Context.Tag("@skygent/Name")` with static `layer`. Use `Layer.effect` (deps), `Layer.scoped` (cleanup), or `Layer.succeed` (pure). Return `ServiceName.of({...})`.

**Effect.gen vs pipe:** Use `Effect.gen` for sequential/conditional logic. Use pipes for simple transforms and stream chains.

**Effect.fn:** Name all service operations — `Effect.fn("Service.method")(...)`.

**Errors:** `Schema.TaggedError` with `message` + optional `cause`, `operation`, `status`. Group as union types. Map at service boundaries.

**Domain types:**
- Branded primitives via `Schema.brand`: `Handle`, `AtUri`, `PostUri`, `StoreName`, `Timestamp`
- `Schema.Class` for entities: `Post`, `AppConfig`, `StoreRef`
- `Schema.TaggedClass` for union variants: `EmbedImages`, `PostUpsert`, `DataSourceFeed`
- `Schema.Union` to compose, `Schema.suspend` for recursion, `Monoid/Semigroup` for composition

**Layers:** Build with `Layer.provideMerge`, assemble with `Layer.mergeAll`. See `src/cli/layers.ts`.

**Config:** CLI flags > env vars > config file > defaults. Override pattern uses `Context.Tag` + `Layer.succeed`.

**Concurrency:** Semaphore + Ref for pooling (`store-db.ts`), `Schedule.exponential.pipe(jittered, recurs)` for retries, `Stream.paginateChunkEffect` for pagination.

## CLI Conventions

**Commands:** `Command.make(name, options, handler)` with `Effect.gen` handler. Yield services, call methods, output with `writeJson`/`writeText`/`writeJsonStream`.

**Options:** Reuse from `src/cli/shared-options.ts`. Schema-validate with `Options.withSchema(PositiveInt)` / `Args.withSchema(AtUri)`. Schemas in `src/cli/option-schemas.ts`.

**Output:** `emitWithFormat()` for polymorphic dispatch. `resolveOutputFormat()` chains CLI flag → config → fallback. Format lists in `src/cli/output-format.ts`.

**Errors:** `CliInputError` (exit 2) / `CliJsonError` for parse failures. Validate early, fail fast. Use `withExamples()` for help text.

**Sync/Watch:** Reuse `makeSyncCommandBody`/`makeWatchCommandBody` from `src/cli/sync-factory.ts`.

## Testing

- `bun test` to run, `bun test --watch` for dev
- Build test layers with `Layer.succeed` for mocks, `Layer.provideMerge` for composition
- Effectful tests: `test("name", () => withTestLayer(Effect.gen(function* () { ... })))`
- Capture output: `makeOutputCapture()` returns `{ layer, stdoutRef }`
- Domain objects: `.make()` constructors — `Post.make({...})`, `Hashtag.make("#ai")`

<!-- effect-solutions:start -->
## References

- `effect-solutions list` / `effect-solutions show <topic>` — Effect patterns guide
- `.reference/effect/` — full Effect source for exploration
- `.reference/bsky-docs/` — AT Protocol API docs
- `.reference/effect-jetstream/` — Jetstream client reference (stream handling, service patterns)
<!-- effect-solutions:end -->

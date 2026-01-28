# Skygent-Bsky: Effect-Native Bluesky CLI Architecture

> **Note:** LLM features described in this plan have been deprecated and removed from the codebase. References to LLM integration below are historical only.

**Date:** 2026-01-25
**Status:** Design
**Purpose:** Agent-driven Bluesky feed monitoring with composable filters and flexible storage

---

## Goals and Objectives

### Primary Goal
Build a production-grade CLI tool that enables AI agents to monitor, collect, and organize Bluesky social data with maximum flexibility and type safety using Effect TypeScript.

### Core Objectives

**1. Agent-First Design**
- **Objective:** Enable AI agents to programmatically interact with Bluesky feeds
- **Success Criteria:**
  - CLI commands return structured JSON for machine parsing
  - Exit codes properly indicate success/failure for automation
  - All operations are idempotent and resumable
  - Markdown output available for human review

**2. Composable Architecture**
- **Objective:** Build a system where filters, streams, and storage compose algebraically
- **Success Criteria:**
  - Filters combine via AND/OR/NOT with monoid laws
  - Multiple data sources merge into unified streams
  - Storage hierarchies support arbitrary nesting
  - Type classes (Filterable, Order) enable generic operations

**3. Flexible Storage**
- **Objective:** Allow agents to create custom storage "stores" with declarative organization
- **Success Criteria:**
  - Agents can create stores with custom directory structures
  - Filters automatically partition data into subfolders
  - Both JSON (structured) and Markdown (readable) formats
  - Config files define default organization rules

**4. Effectful Filtering**
- **Objective:** Support filters that can perform async operations (API calls, LLMs)
- **Success Criteria:**
  - Pure filters for simple predicates (hashtag, author)
  - Effectful filters for validation (check if link works)
  - LLM-based semantic filters (relevance to topic)
  - All filters compose regardless of purity

**5. Type Safety**
- **Objective:** Leverage Effect's type system to prevent runtime errors
- **Success Criteria:**
  - Schema validation for all external data
  - Compile-time guarantees on filter composition
  - Service dependencies tracked in type signatures
  - ParseErrors provide structured error information

**6. Performance**
- **Objective:** Handle large datasets efficiently with lazy evaluation
- **Success Criteria:**
  - Stream-based processing avoids loading entire feeds
  - Chunk operations use structural sharing
  - LLM calls batched and cached automatically
  - Range queries on time-ordered data are O(log n)

### Non-Goals (Out of Scope)

- **Real-time posting/interaction:** Read-only for initial release
- **Web UI:** CLI-only, agents use programmatically
- **Multi-user support:** Single-user configuration
- **Custom feed hosting:** Data collection only, not feed generation
- **Built-in analytics:** Raw data collection, analysis is external

### Success Metrics

1. **Correctness:** All Bluesky posts parse successfully with Schema validation
2. **Composability:** Filters combine without code changes (algebraic laws hold)
3. **Performance:** Process 1000 posts/minute with LLM filtering at 50 posts/batch
4. **Usability:** Agents can create and populate custom stores in <5 commands
5. **Type Safety:** Zero runtime type errors in filter composition

---

## Executive Summary

Skygent is a command-line tool for AI agents to monitor, filter, and persist Bluesky feeds using pure Effect TypeScript patterns. The architecture emphasizes:

- **Composability** - Filters, streams, and storage compose algebraically
- **Effect-Native** - Chunk, HashMap, HashSet instead of JS arrays/objects
- **Type-Safe** - Leverages Effect's type classes (Filterable, Order, Differ)
- **Declarative** - Store configs define organization rules
- **Effectful** - Filters can call LLMs, APIs, or perform async validation
- **Agent-First** - Designed for programmatic use with JSON/Markdown output

### Revision Notes (2026-01-25)

This document now assumes the following architectural updates:

- **Filters are data, not closures**: a `FilterExpr` ADT + interpreter enables serialization, optimization, and predictable evaluation policies.
- **Typed domain primitives**: branded types and `Schema.Class` models for stable IDs, URIs, handles, and timestamps.
- **Typed errors everywhere**: `Schema.TaggedError` for filter, store, sync, and parsing errors.
- **Storage is append-first**: event log + derived index/view layers for robustness and resumability.
- **Config is JSON-first**: external configs are plain JSON, decoded into typed internal structures.
- **LLM/HTTP policies are explicit**: retry/timeout and fail-open/closed rules are configurable per filter.

---

## 1. Core Abstractions

### 1.1 Filters as a Typed ADT (AST + Interpreter)

**Pattern:** Boolean algebra as data + interpreter with explicit evaluation policy.

```typescript
import { Schema } from "effect"

class FilterAll extends Schema.TaggedClass<FilterAll>()("All", {}) {}
class FilterNone extends Schema.TaggedClass<FilterNone>()("None", {}) {}
class FilterAnd extends Schema.TaggedClass<FilterAnd>()("And", {
  left: Schema.lazy(() => FilterExpr),
  right: Schema.lazy(() => FilterExpr)
}) {}
class FilterOr extends Schema.TaggedClass<FilterOr>()("Or", {
  left: Schema.lazy(() => FilterExpr),
  right: Schema.lazy(() => FilterExpr)
}) {}
class FilterNot extends Schema.TaggedClass<FilterNot>()("Not", {
  expr: Schema.lazy(() => FilterExpr)
}) {}

class FilterAuthor extends Schema.TaggedClass<FilterAuthor>()("Author", {
  handle: Handle
}) {}
class FilterHashtag extends Schema.TaggedClass<FilterHashtag>()("Hashtag", {
  tag: Hashtag
}) {}
class FilterDateRange extends Schema.TaggedClass<FilterDateRange>()("DateRange", {
  start: Timestamp,
  end: Timestamp
}) {}
class FilterHasValidLinks extends Schema.TaggedClass<FilterHasValidLinks>()("HasValidLinks", {
  onError: FilterErrorPolicy
}) {}
class FilterTrending extends Schema.TaggedClass<FilterTrending>()("Trending", {
  tag: Hashtag,
  onError: FilterErrorPolicy
}) {}
class FilterLlm extends Schema.TaggedClass<FilterLlm>()("Llm", {
  prompt: Schema.String,
  minConfidence: Schema.Number,
  onError: FilterErrorPolicy
}) {}

export const FilterExpr = Schema.Union(
  FilterAll,
  FilterNone,
  FilterAnd,
  FilterOr,
  FilterNot,
  FilterAuthor,
  FilterHashtag,
  FilterDateRange,
  FilterHasValidLinks,
  FilterTrending,
  FilterLlm
)
export type FilterExpr = typeof FilterExpr.Type
```

**Interpreter (short-circuit, policy-aware):**

```typescript
const and = (left: Predicate, right: Predicate): Predicate =>
  (post) =>
    left(post).pipe(
      Effect.flatMap((ok) => ok ? right(post) : Effect.succeed(false))
    )
```

**Key Features:**
- **Serializable** - Filters are data and can be stored in config or generated by agents
- **Composable** - Monoid over `FilterExpr` (e.g., `And` with identity `All`)
- **Short-circuiting** - evaluation order is explicit and safe for effectful filters
- **Type-safe policies** - fail-open/closed, retries, and timeouts are part of the AST

### 1.2 Domain Types and Primitives

**Pattern:** Branded primitives + `Schema.Class` for runtime validation and type safety.

```typescript
import { Schema } from "effect"

export const Handle = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9.-]{1,63}$/),
  Schema.brand("Handle")
)
export type Handle = typeof Handle.Type

export const Hashtag = Schema.String.pipe(
  Schema.pattern(/^#[a-zA-Z0-9_]+$/),
  Schema.brand("Hashtag")
)
export type Hashtag = typeof Hashtag.Type

export const PostUri = Schema.String.pipe(Schema.brand("PostUri"))
export type PostUri = typeof PostUri.Type

export const PostCid = Schema.String.pipe(Schema.brand("PostCid"))
export type PostCid = typeof PostCid.Type

export const Timestamp = Schema.DateFromString.pipe(Schema.brand("Timestamp"))
export type Timestamp = typeof Timestamp.Type

export class Post extends Schema.Class<Post>("Post")({
  uri: PostUri,
  cid: Schema.optional(PostCid),
  author: Handle,
  text: Schema.String,
  createdAt: Timestamp,
  hashtags: Schema.Array(Hashtag),
  mentions: Schema.Array(Handle),
  links: Schema.Array(Schema.URL)
}) {}

export const StoreName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-_]{1,63}$/),
  Schema.brand("StoreName")
)
export type StoreName = typeof StoreName.Type

export const StorePath = Schema.String.pipe(Schema.brand("StorePath"))
export type StorePath = typeof StorePath.Type
```

**Internal vs External Shapes:**
- External JSON uses arrays/objects for compatibility.
- Internal processing can project to `Chunk`/`HashSet`/`HashMap` for performance.
- Conversions live in a dedicated `PostIndex`/`PostView` module (not ad-hoc).

### 1.3 Schema-Based Parsing

**Pattern:** Parse raw payloads once, transform into validated domain types.

```typescript
import { Schema } from "effect"

class RawPost extends Schema.Class<RawPost>("RawPost")({
  uri: PostUri,
  cid: Schema.optional(PostCid),
  author: Handle,
  record: Schema.Struct({
    text: Schema.String,
    createdAt: Schema.String
  })
}) {}

// Transform raw -> domain Post (validated + enriched)
const PostFromRaw = Schema.transformOrFail(RawPost, Post, {
  decode: (raw) =>
    Schema.decodeUnknown(Post)({
      uri: raw.uri,
      cid: raw.cid,
      author: raw.author,
      text: raw.record.text,
      createdAt: raw.record.createdAt,
      hashtags: extractHashtags(raw.record.text),
      mentions: extractMentions(raw.record.text),
      links: extractLinks(raw.record.text)
    }),
  encode: (post) => ({
    uri: post.uri,
    cid: post.cid,
    author: post.author,
    record: { text: post.text, createdAt: post.createdAt }
  })
})
```

**Key Features:**
- **Regex validation** - `Schema.pattern` for mentions, hashtags, URLs
- **Custom transforms** - Extract entities during decode
- **Type-safe** - Compile-time guarantees on parsed data
- **Error tracking** - Structured ParseError with paths
- **Single decode boundary** - Raw data is decoded once at ingestion

### 1.4 Errors and Policies

**Pattern:** Every subsystem returns tagged, typed errors.

```typescript
class FilterCompileError extends Schema.TaggedError<FilterCompileError>()(
  "FilterCompileError",
  { message: Schema.String }
) {}

class FilterEvalError extends Schema.TaggedError<FilterEvalError>()(
  "FilterEvalError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

class StoreNotFound extends Schema.TaggedError<StoreNotFound>()(
  "StoreNotFound",
  { name: StoreName }
) {}

class StoreIoError extends Schema.TaggedError<StoreIoError>()(
  "StoreIoError",
  { path: StorePath, cause: Schema.Unknown }
) {}

class StoreIndexError extends Schema.TaggedError<StoreIndexError>()(
  "StoreIndexError",
  { message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}

export type StoreError = StoreNotFound | StoreIoError | StoreIndexError
```

```typescript
class IncludeOnError extends Schema.TaggedClass<IncludeOnError>()("Include", {}) {}
class ExcludeOnError extends Schema.TaggedClass<ExcludeOnError>()("Exclude", {}) {}
class RetryOnError extends Schema.TaggedClass<RetryOnError>()("Retry", {
  maxRetries: Schema.Number,
  baseDelay: Schema.Duration
}) {}

export const FilterErrorPolicy = Schema.Union(
  IncludeOnError,
  ExcludeOnError,
  RetryOnError
)
export type FilterErrorPolicy = typeof FilterErrorPolicy.Type
```

---

## 2. Service Architecture

### 2.1 Service Layers

**Core Services:**

```typescript
// Authentication and API client
class BskyClient extends Context.Tag("@skygent/BskyClient")<BskyClient, {
  readonly getTimeline: (opts?: TimelineOpts) => Stream.Stream<RawPost, BskyError>
  readonly getNotifications: Stream.Stream<RawNotification, BskyError>
  readonly getFeed: (uri: string) => Stream.Stream<RawPost, BskyError>
}>() {}

// Parse + enrich raw payloads
class PostParser extends Context.Tag("@skygent/PostParser")<PostParser, {
  readonly parsePost: (raw: RawPost) => Effect.Effect<Post, ParseError>
}>() {}

// Compile filter specs to a typed FilterExpr AST
class FilterCompiler extends Context.Tag("@skygent/FilterCompiler")<FilterCompiler, {
  readonly compile: (spec: FilterSpec) => Effect.Effect<FilterExpr, FilterCompileError>
}>() {}

// Evaluate FilterExpr with policy-aware, short-circuiting semantics
class FilterRuntime extends Context.Tag("@skygent/FilterRuntime")<FilterRuntime, {
  readonly evaluate: (
    expr: FilterExpr
  ) => Effect.Effect<(post: Post) => Effect.Effect<boolean, FilterEvalError>, FilterCompileError>
}>() {}

// Hierarchical storage management (metadata + config)
class StoreManager extends Context.Tag("@skygent/StoreManager")<StoreManager, {
  readonly createStore: (name: StoreName, config: StoreConfig) => Effect.Effect<StoreRef, StoreError>
  readonly getStore: (name: StoreName) => Effect.Effect<Option.Option<StoreRef>, StoreError>
  readonly listStores: Effect.Effect<Chunk.Chunk<StoreMetadata>, StoreError>
}>() {}

// Append-only event log writer
class StoreWriter extends Context.Tag("@skygent/StoreWriter")<StoreWriter, {
  readonly append: (store: StoreRef, event: PostEvent) => Effect.Effect<void, StoreError>
}>() {}

// Queryable index/materialized views
class StoreIndex extends Context.Tag("@skygent/StoreIndex")<StoreIndex, {
  readonly upsert: (store: StoreRef, post: Post) => Effect.Effect<void, StoreError>
  readonly query: (store: StoreRef, query: StoreQuery) => Stream.Stream<Post, StoreError>
}>() {}

// Stream processing and sync
class SyncEngine extends Context.Tag("@skygent/SyncEngine")<SyncEngine, {
  readonly sync: (
    source: DataSource,
    target: StoreRef,
    filter: FilterExpr
  ) => Effect.Effect<SyncResult, SyncError>
  readonly watch: (config: WatchConfig) => Stream.Stream<SyncEvent>
}>() {}
```

### 2.2 Layer Composition

**Dependency Graph:**

```typescript
// Infrastructure
const FileSystemLive = BunFileSystem.layer
const ConfigLive = Layer.effect(Config, loadConfig)
const HttpClientLive = BunHttpClient.layer
const CacheLive = Cache.layer

// Clients
const BskyClientLive = Layer.scoped(
  BskyClient,
  Effect.gen(function* () {
    const config = yield* Config
    const agent = new BskyAgent({ service: config.service })

    yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        agent.login({
          identifier: config.identifier,
          password: config.password
        })
      ),
      () => Effect.promise(() => agent.logout())
    )

    return BskyClient.of({ /* implementation */ })
  })
)

const PostParserLive = Layer.succeed(PostParser, PostParser.of({
  parsePost: (raw) => Schema.decodeUnknown(PostFromRaw)(raw)
}))

const FilterCompilerLive = Layer.effect(FilterCompiler, /* spec -> FilterExpr */)

const FilterRuntimeLive = Layer.effect(
  FilterRuntime,
  Effect.gen(function* () {
    const llm = yield* LanguageModel.LanguageModel
    const cache = yield* Cache.Cache
    const http = yield* HttpClient.HttpClient

    return FilterRuntime.of({ /* policy-aware evaluator */ })
  })
)

const StoreManagerLive = Layer.effect(StoreManager, /* metadata + config only */)
const StoreWriterLive = Layer.effect(StoreWriter, /* append-only event log */)
const StoreIndexLive = Layer.effect(StoreIndex, /* kv index or sqlite (optional) */)

const InfraLive = Layer.mergeAll(
  FileSystemLive,
  ConfigLive,
  HttpClientLive,
  CacheLive,
  LanguageModel.layer
)

// Provide once at the top
const AppLive = Layer.mergeAll(
  BskyClientLive,
  PostParserLive,
  FilterCompilerLive,
  FilterRuntimeLive,
  StoreManagerLive,
  StoreWriterLive,
  StoreIndexLive,
  SyncEngineLive
).pipe(Layer.provide(InfraLive))
```

---

## 3. Storage Model

### 3.1 Store Structure

**Primary persistence:** File-based `KeyValueStore` (Effect Platform) backed by the local filesystem.
The KV store holds event records, metadata, and rebuildable index shards keyed by stable prefixes.
Event keys use time-ordered ULIDs to preserve deterministic replay order.

**Filesystem Layout:**

```
~/.skygent/
  config.json              # Global auth + defaults
  stores/
    arsenal/               # Custom store
      store.json           # Store config (JSON)
      checkpoints.json     # Sync cursors + provenance
      kv/                  # File-based KeyValueStore backing (encoded keys)
      index.sqlite         # Optional read-optimized index (later)
      views/
        timeline/
          all.json
          all.md
        filters/
          tech/
            posts.json
            posts.md
            README.md
          sports/
            posts.json
```

**Logical KV keyspace (illustrative):**

```
events/timeline/<ulid>          -> PostEventRecord (JSON)
events/notifications/<ulid>     -> PostEventRecord (JSON)
events/manifest                 -> string[] (ordered event keys)
indexes/by-date/<yyyy-mm-dd>    -> PostUri[]
indexes/by-hashtag/<tag>        -> PostUri[]
meta/store                      -> Store metadata
```

### 3.2 Store Configuration

**Declarative DSL (JSON-first, typed decode):**

```typescript
class StoreConfig extends Schema.Class<StoreConfig>("StoreConfig")({
  format: Schema.Struct({
    json: Schema.Boolean,
    markdown: Schema.Boolean
  }),
  autoSync: Schema.Boolean,
  syncInterval: Schema.optional(Schema.String), // e.g. "5 minutes" (later decoded to Duration)
  filters: Schema.Array(FilterSpec)
}) {}

class FilterSpec extends Schema.TaggedClass<FilterSpec>()("FilterSpec", {
  name: Schema.String,
  expr: FilterExpr,
  output: Schema.Struct({
    path: Schema.String,   // relative path template
    json: Schema.Boolean,
    markdown: Schema.Boolean
  })
}) {}

// Example config (JSON shape)
const arsenalConfig = {
  format: { json: true, markdown: true },
  autoSync: true,
  syncInterval: "5 minutes",
  filters: [
    {
      name: "tech",
      expr: { _tag: "Hashtag", tag: "#tech" },
      output: { path: "views/filters/tech", json: true, markdown: true }
    },
    {
      name: "sports",
      expr: { _tag: "Hashtag", tag: "#sports" },
      output: { path: "views/filters/sports", json: true, markdown: false }
    }
  ]
}
```

**Note:** External config stays JSON. Internal compilation can convert to `Chunk`/`HashMap` and `Duration`.

### 3.3 Store Data Model

**Using Effect-Native Structures:**

```typescript
export class StoreRef extends Schema.Class<StoreRef>("StoreRef")({
  name: StoreName,
  root: StorePath
}) {}

export class PostKey extends Schema.Class<PostKey>("PostKey")({
  createdAt: Timestamp,
  uri: PostUri
}) {}

// SortedMap enables efficient range queries over keys
const PostKeyOrder = Order.struct({
  createdAt: Order.Date,
  uri: Order.string
})

const timelineIndex = SortedMap.empty<PostKey, Post>(PostKeyOrder)

const recentPosts = SortedMap.getRange(
  timelineIndex,
  PostKey.make({ createdAt: startDate, uri: startUri }),
  PostKey.make({ createdAt: endDate, uri: endUri })
)
```

**Persistence Strategy:**
- **Event log** stored in file-based `KeyValueStore` under stable key prefixes (e.g., `events/timeline/<ulid>`).
- **Indexes/views** are derived and rebuildable.
- **Post identity** uses `PostUri` + optional `PostCid` for revisions.
- **Checkpoints** track last processed event for incremental rebuilds.

### 3.4 Event and Query Models

```typescript
class EventMeta extends Schema.Class<EventMeta>("EventMeta")({
  source: Schema.Literal("timeline", "notifications", "jetstream"),
  command: Schema.String,
  filterExprHash: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  promptHash: Schema.optional(Schema.String),
  createdAt: Timestamp
}) {}

class PostUpsert extends Schema.TaggedClass<PostUpsert>()("PostUpsert", {
  post: Post,
  meta: EventMeta
}) {}

class PostDelete extends Schema.TaggedClass<PostDelete>()("PostDelete", {
  uri: PostUri,
  cid: Schema.optional(PostCid),
  meta: EventMeta
}) {}

export const PostEvent = Schema.Union(PostUpsert, PostDelete)
export type PostEvent = typeof PostEvent.Type

export const EventId = Schema.ULID.pipe(Schema.brand("EventId"))
export type EventId = typeof EventId.Type

class PostEventRecord extends Schema.Class<PostEventRecord>("PostEventRecord")({
  id: EventId,
  version: Schema.Literal(1),
  event: PostEvent
}) {}

class StoreQuery extends Schema.Class<StoreQuery>("StoreQuery")({
  range: Schema.optional(Schema.Struct({ start: Timestamp, end: Timestamp })),
  filter: Schema.optional(FilterExpr),
  limit: Schema.optional(Schema.Number)
}) {}
```

---

## 4. Filter System

### 4.1 Filter Types

**1. Simple Filters (Pure):**

```typescript
const Filters = {
  author: (handle: Handle): FilterExpr =>
    new FilterAuthor({ handle }),

  hashtag: (tag: Hashtag): FilterExpr =>
    new FilterHashtag({ tag }),

  dateRange: (start: Timestamp, end: Timestamp): FilterExpr =>
    new FilterDateRange({ start, end })
}
```

**2. Effectful Filters (Async):**

```typescript
const EffectfulFilters = {
  isTrending: (tag: Hashtag): FilterExpr =>
    new FilterTrending({
      tag,
      onError: { _tag: "Include" } // fail-open by default
    }),

  hasValidLinks: (): FilterExpr =>
    new FilterHasValidLinks({
      onError: { _tag: "Exclude" }
    })
}
```

**3. LLM-Based Filters (Semantic):**

```typescript
const SemanticFilters = {
  relevantTo: (topic: string): FilterExpr =>
    new FilterLlm({
      prompt: `Is this post relevant to ${topic}?`,
      minConfidence: 0.7,
      onError: { _tag: "Include" }
    })
}
```

### 4.2 Filter Composition

**Algebraic Combinators:**

```typescript
const and = (left: FilterExpr, right: FilterExpr) => new FilterAnd({ left, right })
const or = (left: FilterExpr, right: FilterExpr) => new FilterOr({ left, right })
const not = (expr: FilterExpr) => new FilterNot({ expr })

// Combine multiple filters with AND
const techPosts = Chunk.make(
  Filters.hashtag("#typescript" as Hashtag),
  Filters.hashtag("#effect" as Hashtag),
  Filters.author("alice.bsky" as Handle)
).pipe(
  Chunk.reduce(new FilterAll({}), (acc, next) => and(acc, next))
)

// Build complex filter with OR/NOT
const interestingPosts = not(
  and(
    or(
      Filters.author("alice.bsky" as Handle),
      Filters.hashtag("#effect" as Hashtag)
    ),
    Filters.dateRange(
      Timestamp.make(new Date("2024-01-01").toISOString()),
      Timestamp.make(new Date().toISOString())
    )
  )
)
```

### 4.3 Filter Execution Strategies

**Sequential (Default):**

```typescript
const predicate = yield* filterRuntime.evaluate(filterExpr)

const filtered = yield* posts.pipe(
  Stream.filterEffect((post) => predicate(post))
)
```

**Batched (For LLM Filters):**

```typescript
// Runtime uses RequestResolver + Effect.request to batch LLM calls
const evaluateBatch = yield* FilterRuntime.evaluateBatch(filterExpr)
const filtered = yield* posts.pipe(
  Stream.grouped(10),
  Stream.mapEffect(evaluateBatch),
  Stream.flattenChunks
)
```

---

## 5. Data Processing Pipeline

### 5.1 Stream-Based Processing

**Pattern:** Lazy evaluation with backpressure

```typescript
const processFeed = (source: DataSource, storeName: StoreName, filterSpec: FilterSpec) =>
  Effect.gen(function* () {
    const client = yield* BskyClient
    const parser = yield* PostParser
    const compiler = yield* FilterCompiler
    const runtime = yield* FilterRuntime
    const storeManager = yield* StoreManager
    const writer = yield* StoreWriter
    const index = yield* StoreIndex

    const store = yield* storeManager.getStore(storeName).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(StoreNotFound.make({ name: storeName })),
        onSome: Effect.succeed
      }))
    )

    const filterExpr = yield* compiler.compile(filterSpec)
    const predicate = yield* runtime.evaluate(filterExpr)

    const stream = yield* client.getTimeline()

    yield* stream.pipe(
      Stream.mapEffect(parser.parsePost),
      Stream.filterEffect(predicate),
      Stream.tap((post) => writer.append(store, PostEvent.fromPost(post))),
      Stream.tap((post) => index.upsert(store, post)),
      Stream.runDrain
    )
  })
```

### 5.2 Markdown Generation

**Pattern:** Transform enriched posts to human-readable format (facet-aware, safe escaping)

```typescript
const generateMarkdown = (post: Post): string => {
  const header = `# Post by @${post.author}\n\n**Created:** ${post.createdAt.toISOString()}\n\n`
  const body = renderMarkdownFromFacets({
    text: post.text,
    mentions: post.mentions,
    hashtags: post.hashtags,
    links: post.links
  })

  const tags =
    post.hashtags.length > 0 ? `\n\n**Tags:** ${post.hashtags.join(", ")}` : ""

  return `${header}${body}${tags}\n`
}
```

---

## 6. CLI Interface

### 6.1 Command Structure

**Verb-Based Commands:**

```bash
# Store management
skygent store create <name> [--config <path>]
skygent store list
skygent store show <name>
skygent store delete <name>

# Syncing
skygent sync timeline --store <name> [--filter <expr>]
skygent sync notifications --store <name>
skygent sync feed <uri> --store <name>

# Watching (real-time)
skygent watch timeline --store <name> [--filter <expr>]

# Filtering (one-shot)
skygent filter timeline --expr "hashtag:#tech AND author:alice"
skygent filter timeline --llm "posts about Effect TypeScript"

# Querying
skygent query <store> --range <start>..<end>
skygent query <store> --filter <expr>
```

### 6.2 CLI Implementation

**Using @effect/cli:**

```typescript
import { Command, Options, Args } from "@effect/cli"

const storeCreate = Command.make(
  "create",
  {
    name: Args.text({ name: "name" }),
    config: Options.file("config").pipe(Options.optional)
  },
  ({ name, config }) =>
    Effect.gen(function*() {
      const storeManager = yield* StoreManager

      const cfg = config ?
        yield* parseConfig(config) :
        defaultStoreConfig

      const store = yield* storeManager.createStore(name, cfg)

      yield* Effect.log(`Created store: ${store.name}`)
      yield* Effect.log(`Path: ${store.path}`)
    })
)

const syncTimeline = Command.make(
  "timeline",
  {
    store: Options.text("store"),
    filter: Options.text("filter").pipe(Options.optional)
  },
  ({ store, filter }) =>
    Effect.gen(function*() {
      const sync = yield* SyncEngine
      const compiler = yield* FilterCompiler

      const filterExpr = filter
        ? yield* compiler.compile(parseFilterExpr(filter))
        : new FilterAll({})

      const result = yield* sync.sync(
        DataSource.timeline(),
        { name: store },
        filterExpr
      )

      yield* Effect.log(`Synced ${result.count} posts to ${store}`)
    })
)

const app = Command.make("skygent", {}, () =>
  Effect.log("Skygent CLI - Bluesky monitoring for agents")
).pipe(
  Command.withSubcommands([
    ["store", storeCommands],
    ["sync", syncCommands],
    ["watch", watchCommands],
    ["filter", filterCommands],
    ["query", queryCommands]
  ])
)
```

**Output Policy (Agent-First):**
- **Stdout:** structured JSON (`--format json` default)
- **Stderr:** human-readable logs, progress, warnings
- **Optional:** `--format markdown|table` for human review without breaking automation

---

## 7. Integration Patterns

### 7.1 LLM Integration

**Batched Processing:**

```typescript
const batchAnalyze = (posts: Chunk.Chunk<Post>) =>
  LanguageModel.generateObject({
    prompt: `Analyze sentiment for each post:\n${
      posts.pipe(
        Chunk.map((p, i) => `${i}. ${p.text}`),
        Chunk.join("\n")
      )
    }`,
    schema: Schema.Struct({
      sentiments: Schema.Array(
        Schema.Literal("positive", "negative", "neutral")
      )
    })
  }).pipe(
    Effect.map(r => Chunk.zip(posts, Chunk.fromIterable(r.value.sentiments)))
  )

// Use in stream
const analyzed = timeline.pipe(
  Stream.grouped(10),
  Stream.mapEffect(batchAnalyze),
  Stream.flattenChunks
)
```

**Caching Strategy:**

```typescript
// Cache LLM results by (model + promptHash + contentHash)
class LlmKey extends Schema.Class<LlmKey>("LlmKey")({
  model: Schema.String,
  promptHash: Schema.String,
  contentHash: Schema.String
}) {}

const cachedClassify = yield* Cache.make({
  capacity: 10000,
  timeToLive: Duration.hours(24),
  lookup: (key: LlmKey) =>
    LanguageModel.generateObject({
      prompt: loadPrompt(key.promptHash),
      schema: Schema.Struct({ category: Schema.String })
    }).pipe(Effect.map(r => r.value.category))
})

const classifyPost = (post: Post, model: string, promptHash: string) =>
  cachedClassify.get(
    LlmKey.make({
      model,
      promptHash,
      contentHash: hash(post.text)
    })
  )

// Persist provenance for reproducibility
const annotation: LlmAnnotation = {
  model,
  promptHash,
  createdAt: new Date(),
  output: "category"
}
```

### 7.2 Type Class Usage

**Filterable for Streams:**

```typescript
import { Filterable } from "@effect/typeclass/Filterable"

// Partition stream by predicate
const [tech, other] = yield* timeline.pipe(
  Stream.partition((post) =>
    post.hashtags.includes("#tech" as Hashtag)
  )
)

// FilterMap combines filter and transform
const summaries = yield* timeline.pipe(
  Stream.filterMapEffect((post) =>
    isInteresting(post).pipe(
      Effect.flatMap((interesting) =>
        interesting ?
          summarize(post).pipe(Effect.map(Option.some)) :
          Effect.succeed(Option.none())
      )
    )
  )
)
```

**Differ for Incremental Updates:**

```typescript
const postDiffer = Differ.hashMap(Differ.make({
  empty: undefined,
  diff: (old, new) => /* compute diff */,
  combine: (p1, p2) => p2,  // Last write wins
  patch: (patch, old) => /* apply patch */
}))

// Compute minimal update
const oldPosts = /* previous state */
const newPosts = /* current state */
const patch = postDiffer.diff(oldPosts, newPosts)

// Apply patch efficiently
const updated = postDiffer.patch(patch, oldPosts)
```

---

## 8. Performance Optimizations

### 8.1 Chunk Operations

**Use Chunk instead of Array:**

```typescript
// Bad: Materializes intermediate arrays
const result = posts
  .filter(p => p.author === "alice")
  .map(p => p.text)
  .slice(0, 10)

// Good: Structural sharing, lazy slicing
const result = Chunk.fromIterable(posts).pipe(
  Chunk.filter(p => p.author === "alice"),
  Chunk.map(p => p.text),
  Chunk.take(10)
)
```

### 8.2 HashMap for Lookups

**Replace object literals:**

```typescript
// Bad: O(n) lookup in array
const byAuthor = posts.reduce((acc, post) => {
  acc[post.author] = [...(acc[post.author] || []), post]
  return acc
}, {} as Record<string, Post[]>)

// Good: O(1) average lookup with HashMap
const byAuthor = Chunk.reduce(
  posts,
  HashMap.empty<string, Chunk.Chunk<Post>>(),
  (map, post) => {
    const existing = HashMap.get(map, post.author).pipe(
      Option.getOrElse(() => Chunk.empty<Post>())
    )
    return HashMap.set(map, post.author, Chunk.append(existing, post))
  }
)
```

### 8.3 SortedMap for Range Queries

**Time-ordered access:**

```typescript
// Bad: Filter entire array
const recent = posts.filter(p =>
  p.createdAt >= startDate && p.createdAt <= endDate
)

// Good: O(k + log n) range query
const recent = SortedMap.getRange(
  timelineSortedMap,
  startDate,
  endDate
)
```

### 8.4 LLM Request Batching

**Combine requests:**

```typescript
// Bad: 100 individual LLM calls
for (const post of posts) {
  const sentiment = await classifySentiment(post.text)
}

// Good: RequestResolver batches LlmDecisionRequest into a single decideBatch call
const decide = (post: Post) =>
  Effect.request(new LlmDecisionRequest({ prompt, text: post.text }), LlmResolver)

const decisions = yield* Effect.all(
  posts.map(decide),
  { batching: true }
)
```

---

## 9. Testing Strategy

### 9.1 Layer Swapping

**Test vs Production Layers:**

```typescript
// Production: real Bluesky API
const BskyClientLive = Layer.scoped(BskyClient, /* ... */)

// Test: mock responses
const BskyClientTest = Layer.succeed(
  BskyClient,
  BskyClient.of({
    getTimeline: () => Stream.make(mockPost1, mockPost2),
    getNotifications: () => Stream.empty,
    getFeed: () => Stream.empty
  })
)

// Swap in tests
const testProgram = program.pipe(
  Effect.provide(BskyClientTest)
)
```

### 9.2 Property-Based Testing

**Filter algebra laws:**

```typescript
import * as fc from "fast-check"

// Associativity: (f1 && f2) && f3 === f1 && (f2 && f3)
fc.assert(
  fc.property(
    fc.array(fc.string()),
    (posts) => {
      const f1 = new FilterAuthor({ handle: "alice.bsky" as Handle })
      const f2 = new FilterHashtag({ tag: "#tech" as Hashtag })
      const f3 = new FilterDateRange({ start, end })

      const left = new FilterAnd({ left: new FilterAnd({ left: f1, right: f2 }), right: f3 })
      const right = new FilterAnd({ left: f1, right: new FilterAnd({ left: f2, right: f3 }) })

      // Should produce same results under the same runtime
      const predicateLeft = yield* filterRuntime.evaluate(left)
      const predicateRight = yield* filterRuntime.evaluate(right)

      posts.forEach((post) => {
        expect(predicateLeft(post)).toEqual(predicateRight(post))
      })
    }
  )
)
```

---

## 10. Implementation Priorities

### Phase 1: Foundation (Week 1)
- [ ] Project setup with Effect Language Service
- [ ] Core data structures (Post, FilterExpr, error types)
- [ ] Schema definitions for Bluesky post parsing
- [ ] BskyClient service with authentication

### Phase 2: Filtering (Week 2)
- [ ] FilterExpr ADT + combinators
- [ ] Simple filters (author, hashtag, date)
- [ ] FilterCompiler + FilterRuntime services
- [ ] Stream filtering pipeline

### Phase 3: Storage (Week 3)
- [ ] StoreRef, StorePath, PostEvent models
- [ ] StoreManager service
- [ ] Event log writer + index builder
- [ ] JSON/Markdown view generation

### Phase 4: Sync & CLI (Week 4)
- [ ] SyncEngine service
- [ ] CLI commands (@effect/cli)
- [ ] Configuration management
- [ ] End-to-end integration

### Phase 5: Advanced Features (Week 5+)
- [ ] LLM-based filters
- [ ] Batched processing
- [ ] Caching layer
- [ ] Real-time watching

---

## 11. Key Design Decisions

### Why Effect-Native Structures?

1. **Chunk** - O(log n) concatenation vs O(n) for arrays
2. **HashMap** - O(1) average lookup with structural sharing
3. **SortedMap** - O(log n) range queries for time-ordered data
4. **HashSet** - O(1) membership testing for hashtags/mentions

### Why Algebraic Filters?

1. **Composability** - Combine filters without nesting complexity
2. **Testability** - Algebraic laws enable property-based testing
3. **Flexibility** - Mix pure, effectful, and LLM-based nodes with policies
4. **Serialization** - Filters can be stored, diffed, and optimized
5. **Performance** - Short-circuit and batched evaluation strategies

### Why Schema Transformations?

1. **Type Safety** - Compile-time guarantees on parsed data
2. **Validation** - Regex patterns, length checks, custom rules
3. **Extraction** - Parse mentions/hashtags/links declaratively
4. **Encoding** - Bidirectional transforms for serialization

### Why Service Layers?

1. **Testability** - Swap implementations via Layer composition
2. **Dependency Injection** - Context.Tag provides type-safe DI
3. **Resource Management** - Layer.scoped handles cleanup
4. **Composition** - Build app from independent services

---

## 12. Decisions & Remaining Questions (2026-01-25)

**Decisions**
1. **Jetstream Integration** - Yes, as an optional `DataSource` using the `effect-jetstream` package; it will feed the same parser + filter + store pipeline.
2. **Custom Feed Generation** - Not in MVP. Keep event log + index so a future worker can read from the same store.
3. **Persistence Format** - File-based `KeyValueStore` for event log + metadata + rebuildable indices; SQLite is optional for read-heavy workloads.
4. **CLI Output Format** - JSON to stdout by default; optional `--format markdown|table` for humans; logs to stderr.
5. **Agent Memory / Provenance** - Yes. Every event includes `source`, `command`, `filterExprHash`, `model/promptHash`, and timestamp.

**Current Defaults (can revisit)**
- **Model selection**: Provider-agnostic with config-driven primary + fallback; no hard default. Decide if we want a first-class “default provider” once usage stabilizes.
- **Retention policy**: Default to retain raw events indefinitely; add optional per-store TTL pruning for derived views.
- **Index strategy**: Start with KV-backed index shards; introduce SQLite only when queries exceed KV scan costs.

---

## 13. Architectural Research Foundation

This design is informed by comprehensive research into functional programming patterns, data structures, and domain modeling from the following technical books, accessed via Book Search API at `http://127.0.0.1:8787`.

### Books Consulted

**Composable Filter Patterns:**
- **Algebra-Driven Design** - Filter algebras, boolean homomorphisms, monoid composition
- **Domain Modeling Made Functional** - Smart constructors, making illegal states unrepresentable
- **Functional Design and Architecture** - Free monads, interpreter patterns, DSL design

**Stream and Pipeline Composition:**
- **Functional Design and Architecture** - Stream transformations, reactive patterns
- **Designing Data Intensive Applications** - Backpressure, windowing, stream joins
- **Purely Functional Data Structures** - Lazy evaluation, persistent structures

**Storage and File System Abstractions:**
- **Domain Modeling Made Functional** - DDD aggregates, repository patterns
- **The Art of Immutable Architecture** - Event sourcing, immutable storage
- **Functional Design and Architecture** - I/O at edges, dependency injection

**Declarative Configuration Patterns:**
- **Algebra-Driven Design** - Algebraic specifications, combinator libraries
- **Pragmatic Type-Level Design** - Phantom types, type-level state machines
- **Domain Modeling Made Functional** - Railway-oriented programming, validation composition

**Data Structures and Type Classes:**
- **Purely Functional Data Structures** - Persistent structures, amortization
- Effect TypeScript documentation - Chunk, HashMap, SortedMap, type classes

### Key Insights Applied

1. **Algebraic Foundations (Algebra-Driven Design)**
   - Filters as boolean homomorphisms with 25+ algebraic laws
   - Monoid composition for combining filters associatively
   - Gate pattern for separating filtering from actions

2. **Stream Composition (Functional Design & Architecture)**
   - Lazy evaluation with memoization for efficiency
   - Pipeline operators for declarative data flow
   - Backpressure via pull-based streams

3. **Storage Abstractions (Domain Modeling Made Functional)**
   - Smart constructors for validated paths
   - Specification pattern for queries
   - Repository pattern replaced with function composition

4. **Declarative DSLs (Pragmatic Type-Level Design)**
   - Free monad DSL for configuration
   - Phantom types for compile-time safety
   - Interpreter pattern for multiple backends

5. **Effect-Native Structures (Effect Documentation)**
   - Chunk: O(log n) concatenation with structural sharing
   - HashMap: O(1) lookups with HAMT implementation
   - SortedMap: O(log n) range queries with Red-Black Tree
   - Type classes: Filterable, Order, Differ for generic operations

### Book Search API

The research utilized a FastAPI server providing hybrid vector + text search over chunked technical book content:

**Endpoint:** `http://127.0.0.1:8787`

**Available Books (15 total):**
- algorithms-jeff-erickson.pdf (1615 chunks)
- purely-functional-data-structures.pdf (646 chunks)
- algebra-driven-design.pdf (633 chunks)
- designing-data-intensive-applications.pdf (1830 chunks)
- domain-modeling-made-functional.pdf (689 chunks)
- functional-design-and-architecture.pdf (1081 chunks)
- the-art-of-immutable-architecture.pdf (1031 chunks)
- pragmatic-type-level-design.pdf (529 chunks)
- And 7 more architectural/design books

**API Operations:**
```bash
# List all books
GET /books

# Search with filters
POST /search
{
  "query": "composable filters",
  "limit": 10,
  "mode": "hybrid",  # hybrid | vector | fts
  "filters": {
    "books": ["algebra-driven-design.pdf"],
    "chunk_types": ["prose", "code"]
  }
}

# Get specific chunk with context
GET /chunks/{chunk_id}/context?before=1&after=1
```

This API enabled deep research into established patterns before committing to architectural decisions, ensuring the design aligns with proven functional programming principles.

---

## Conclusion

This architecture provides a solid foundation for building a composable, type-safe, agent-driven Bluesky CLI using pure Effect patterns. The emphasis on algebraic composition, Effect-native data structures, and service-based design enables maximum flexibility while maintaining strong guarantees.

Next steps: Move to implementation planning with detailed file structure and coding priorities.

# Skygent-Bsky: Effect-Native Bluesky CLI Architecture

**Date:** 2026-01-25
**Status:** Design
**Purpose:** Agent-driven Bluesky feed monitoring with composable filters, flexible storage, and LLM integration

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

---

## 1. Core Abstractions

### 1.1 Filters as Algebraic Structures

**Pattern:** Boolean algebra with Monoid composition

```typescript
import { Monoid, Chunk, Effect, HashMap } from "effect"

interface Filter<A> {
  readonly predicate: (a: A) => Effect.Effect<boolean>
  readonly and: (other: Filter<A>) => Filter<A>
  readonly or: (other: Filter<A>) => Filter<A>
  readonly not: () => Filter<A>
}

// Monoid for combining filters
const FilterMonoid: Monoid.Monoid<Filter<Post>> = {
  empty: { predicate: () => Effect.succeed(true), ... },
  combine: (f1, f2) => ({
    predicate: (post) => Effect.all([
      f1.predicate(post),
      f2.predicate(post)
    ]).pipe(Effect.map(([r1, r2]) => r1 && r2)),
    ...
  })
}
```

**Key Features:**
- **Associative** - `(f1 && f2) && f3 === f1 && (f2 && f3)`
- **Identity** - `f && always === f`
- **Composable** - Use `Chunk.reduce` to combine filter lists
- **Effectful** - Predicates return `Effect<boolean>` for async operations

### 1.2 Effect-Native Data Structures

**Pattern:** Replace JS primitives with Effect structures

```typescript
interface Post {
  readonly uri: string
  readonly text: string
  readonly author: string
  readonly createdAt: Date
  readonly metadata: HashMap.HashMap<string, unknown>  // Not plain object
  readonly hashtags: HashSet.HashSet<string>           // Not Set
  readonly mentions: HashSet.HashSet<string>           // Not Set
  readonly links: Chunk.Chunk<URL>                     // Not Array
}
```

**Benefits:**
- **Structural sharing** - O(log n) updates, not O(n) copies
- **Immutability** - No accidental mutations
- **Performance** - Chunk concatenation is O(log n), not O(n)
- **Integration** - Native support in Stream and Effect APIs

### 1.3 Schema-Based Parsing

**Pattern:** Transform raw JSON to domain models with validation

```typescript
import { Schema } from "effect"

const HashtagSchema = Schema.String.pipe(
  Schema.pattern(/^#[a-zA-Z0-9_]+$/),
  Schema.minLength(2),
  Schema.maxLength(64)
)

const EnrichedPost = Schema.transform(
  RawPost,
  Schema.Struct({
    text: Schema.String,
    mentions: Schema.Array(MentionSchema),
    hashtags: Schema.Array(HashtagSchema),
    links: Schema.Array(LinkSchema)
  }),
  {
    decode: (raw) => ({
      text: raw.record.text,
      mentions: extractMentions(raw.record.text),
      hashtags: extractHashtags(raw.record.text),
      links: extractLinks(raw.record.text)
    }),
    encode: (enriched) => ({ record: { text: enriched.text } })
  }
)
```

**Key Features:**
- **Regex validation** - `Schema.pattern` for mentions, hashtags, URLs
- **Custom transforms** - Extract entities during decode
- **Type-safe** - Compile-time guarantees on parsed data
- **Error tracking** - Structured ParseError with paths

---

## 2. Service Architecture

### 2.1 Service Layers

**Core Services:**

```typescript
// Authentication and API client
class BskyClient extends Context.Tag("BskyClient")<BskyClient, {
  readonly getTimeline: (opts?: TimelineOpts) => Stream.Stream<Post, BskyError>
  readonly getNotifications: Stream.Stream<Notification, BskyError>
  readonly getFeed: (uri: string) => Stream.Stream<Post, BskyError>
}>() {}

// Composable filter evaluation
class FilterEngine extends Context.Tag("FilterEngine")<FilterEngine, {
  readonly evaluate: (filter: Filter<Post>) => (post: Post) => Effect.Effect<boolean>
  readonly compile: (config: FilterConfig) => Effect.Effect<Filter<Post>>
  readonly llmFilter: (prompt: string) => Filter<Post>
}>() {}

// Hierarchical storage management
class StoreManager extends Context.Tag("StoreManager")<StoreManager, {
  readonly createStore: (name: string, config: StoreConfig) => Effect.Effect<Store>
  readonly getStore: (name: string) => Effect.Effect<Option.Option<Store>>
  readonly listStores: Effect.Effect<Chunk.Chunk<StoreMetadata>>
  readonly stores: Effect.Effect<HashMap.HashMap<string, Store>>
}>() {}

// Stream processing and sync
class SyncEngine extends Context.Tag("SyncEngine")<SyncEngine, {
  readonly sync: (
    source: DataSource,
    target: Store,
    filter: Filter<Post>
  ) => Effect.Effect<SyncResult>
  readonly watch: (config: WatchConfig) => Stream.Stream<SyncEvent>
}>() {}
```

### 2.2 Layer Composition

**Dependency Graph:**

```typescript
// Infrastructure
const FileSystemLive = NodeFileSystem.layer
const ConfigLive = Layer.succeed(Config, loadConfig())

// Clients
const BskyClientLive = Layer.scoped(
  BskyClient,
  Effect.gen(function*() {
    const config = yield* Config
    const agent = new BskyAgent({ service: config.service })

    yield* Effect.acquireRelease(
      Effect.tryPromise(() => agent.login({
        identifier: config.identifier,
        password: config.password
      })),
      () => Effect.promise(() => agent.logout())
    )

    return BskyClient.of({ /* implementation */ })
  })
)

// Services
const FilterEngineLive = Layer.effect(
  FilterEngine,
  Effect.gen(function*() {
    const llm = yield* LanguageModel.LanguageModel

    return FilterEngine.of({
      evaluate: (filter) => (post) => filter.predicate(post),
      llmFilter: (prompt) => ({
        predicate: (post) =>
          LanguageModel.generateObject({
            prompt: `${prompt}\n\nPost: ${post.text}`,
            schema: Schema.Struct({ isRelevant: Schema.Boolean })
          }).pipe(
            Effect.map(r => r.value.isRelevant),
            Effect.cached(Duration.minutes(5))
          ),
        ...
      })
    })
  })
)

const StoreManagerLive = Layer.effect(
  StoreManager,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const stores = yield* Ref.make(HashMap.empty<string, Store>())

    return StoreManager.of({ /* implementation */ })
  })
)

// Application composition
const AppLive = Layer.mergeAll(
  BskyClientLive.pipe(Layer.provide(ConfigLive)),
  FilterEngineLive,
  StoreManagerLive.pipe(Layer.provide(FileSystemLive)),
  SyncEngineLive
)
```

---

## 3. Storage Model

### 3.1 Store Structure

**Filesystem Layout:**

```
~/.skygent/
  config.json              # Global auth + defaults
  stores/
    arsenal/               # Custom store
      store.json           # Store config (filters, rules)
      timeline/
        all.json           # Full timeline (Chunk<Post>)
        all.md             # Readable markdown
        tech/
          posts.json       # Filtered posts (HashMap<string, Post>)
          posts.md
          README.md        # Filter rules explanation
        sports/
          posts.json
      notifications/
        mentions.json
```

### 3.2 Store Configuration

**Declarative DSL:**

```typescript
interface StoreConfig {
  readonly format: {
    readonly json: boolean
    readonly markdown: boolean
  }
  readonly filters: HashMap.HashMap<string, FilterConfig>
  readonly autoSync: boolean
  readonly syncInterval?: Duration.Duration
}

interface FilterConfig {
  readonly type: "hashtag" | "author" | "date" | "llm" | "composite"
  readonly rules: unknown  // Type depends on filter type
}

// Example config
const arsenalConfig: StoreConfig = {
  format: { json: true, markdown: true },
  filters: HashMap.make(
    ["tech", { type: "hashtag", rules: { tags: ["#tech", "#typescript"] } }],
    ["sports", { type: "hashtag", rules: { tags: ["#sports"] } }]
  ),
  autoSync: true,
  syncInterval: Duration.minutes(5)
}
```

### 3.3 Store Data Model

**Using Effect-Native Structures:**

```typescript
interface Store {
  readonly name: string
  readonly path: StorePath
  readonly filters: Chunk.Chunk<Filter<Post>>
  readonly posts: SortedMap.SortedMap<string, Post>  // Time-ordered
  readonly metadata: HashMap.HashMap<string, unknown>
}

// SortedMap enables efficient range queries
const PostOrder = Order.combine(
  Order.mapInput(Order.Date, (p: Post) => p.createdAt),
  Order.mapInput(Order.string, (p: Post) => p.uri)
)

// Create time-ordered store
const timelineStore = SortedMap.empty(PostOrder)

// Efficient range queries
const recentPosts = SortedMap.getRange(
  timelineStore,
  startDate,
  endDate
)
```

---

## 4. Filter System

### 4.1 Filter Types

**1. Simple Filters (Pure):**

```typescript
const PostFilters = {
  author: (handle: string): Filter<Post> => ({
    predicate: (post) => Effect.succeed(post.author === handle),
    ...
  }),

  hashtag: (tag: string): Filter<Post> => ({
    predicate: (post) => Effect.succeed(
      HashSet.has(post.hashtags, tag)
    ),
    ...
  }),

  dateRange: (start: Date, end: Date): Filter<Post> => ({
    predicate: (post) => Effect.succeed(
      post.createdAt >= start && post.createdAt <= end
    ),
    ...
  })
}
```

**2. Effectful Filters (Async):**

```typescript
const EffectfulFilters = {
  isTrending: (tag: string): Filter<Post> => ({
    predicate: (post) =>
      HttpClient.get(`/api/trending/${tag}`).pipe(
        Effect.map(r => r.trending),
        Effect.orElse(() => Effect.succeed(false))
      ),
    ...
  }),

  hasValidLinks: (): Filter<Post> => ({
    predicate: (post) =>
      Effect.forEach(
        post.links,
        (link) => HttpClient.head(link.href).pipe(
          Effect.map(_ => true),
          Effect.catchAll(() => Effect.succeed(false))
        ),
        { concurrency: 3 }
      ).pipe(
        Effect.map(results => Chunk.every(results, x => x))
      ),
    ...
  })
}
```

**3. LLM-Based Filters (Semantic):**

```typescript
const SemanticFilters = {
  relevantTo: (topic: string): Filter<Post> => ({
    predicate: (post) =>
      LanguageModel.generateObject({
        prompt: `Is this post relevant to ${topic}? Post: "${post.text}"`,
        schema: Schema.Struct({
          isRelevant: Schema.Boolean,
          confidence: Schema.Number
        })
      }).pipe(
        Effect.map(r => r.value.isRelevant && r.value.confidence > 0.7),
        Effect.cached(Duration.minutes(10))  // Cache expensive LLM calls
      ),
    ...
  }),

  sentiment: (target: "positive" | "negative"): Filter<Post> => ({
    predicate: (post) =>
      LanguageModel.generateObject({
        prompt: `Classify sentiment: ${post.text}`,
        schema: Schema.Struct({
          sentiment: Schema.Literal("positive", "negative", "neutral")
        })
      }).pipe(
        Effect.map(r => r.value.sentiment === target)
      ),
    ...
  })
}
```

### 4.2 Filter Composition

**Algebraic Combinators:**

```typescript
// Combine multiple filters with AND
const techPosts = Chunk.make(
  PostFilters.hashtag("#typescript"),
  PostFilters.hashtag("#effect"),
  PostFilters.author("alice.bsky")
).pipe(
  Chunk.reduce(FilterMonoid.empty, FilterMonoid.combine)
)

// Build complex filter with OR/NOT
const interestingPosts = PostFilters.author("alice.bsky")
  .or(PostFilters.hashtag("#effect"))
  .and(PostFilters.dateRange(new Date("2024-01-01"), new Date()))
  .not(PostFilters.author("spammer.bsky"))
```

### 4.3 Filter Execution Strategies

**Sequential (Default):**

```typescript
const filtered = yield* posts.pipe(
  Stream.filterEffect((post) => filter.predicate(post))
)
```

**Batched (For LLM Filters):**

```typescript
const batchedLLMFilter = (topic: string) =>
  Effect.gen(function*() {
    const cached = yield* Effect.cached(
      (batch: Chunk.Chunk<Post>) =>
        LanguageModel.generateObject({
          prompt: `Rate relevance to ${topic} (0-10) for each:\n${
            Chunk.map(batch, p => `- ${p.text}`).pipe(Chunk.join("\n"))
          }`,
          schema: Schema.Struct({
            scores: Schema.Array(Schema.Number)
          })
        }).pipe(
          Effect.map(r => Chunk.fromIterable(r.value.scores))
        ),
      Duration.minutes(10)
    )

    return (posts: Stream.Stream<Post>) =>
      posts.pipe(
        Stream.grouped(10),  // Batch size 10
        Stream.mapEffect((batch) =>
          cached(batch).pipe(
            Effect.map((scores) =>
              Chunk.zip(batch, scores).pipe(
                Chunk.filter(([_, score]) => score > 7),
                Chunk.map(([post, _]) => post)
              )
            )
          )
        ),
        Stream.flattenChunks
      )
  })
```

---

## 5. Data Processing Pipeline

### 5.1 Stream-Based Processing

**Pattern:** Lazy evaluation with backpressure

```typescript
const processFeed = (source: DataSource) =>
  Effect.gen(function*() {
    const client = yield* BskyClient
    const filterEngine = yield* FilterEngine
    const storage = yield* StoreManager

    // Fetch timeline as stream
    const timeline = yield* client.getTimeline()

    // Apply filter pipeline
    const filtered = timeline.pipe(
      // 1. Parse with Schema
      Stream.mapEffect((raw) => Schema.decode(EnrichedPost)(raw)),

      // 2. Fast heuristic filter
      Stream.filter((post) => HashSet.size(post.hashtags) > 0),

      // 3. Effectful validation
      Stream.filterEffect((post) =>
        EffectfulFilters.hasValidLinks().predicate(post)
      ),

      // 4. LLM semantic filter (batched)
      Stream.grouped(10),
      Stream.mapEffect((batch) => llmBatchFilter(batch)),
      Stream.flattenChunks,

      // 5. Transform to markdown
      Stream.map(generateMarkdown)
    )

    // Persist to store
    yield* filtered.pipe(
      Stream.runForEach((post) =>
        storage.getStore("arsenal").pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail("Store not found"),
            onSome: (store) => savePost(store, post)
          }))
        )
      )
    )
  })
```

### 5.2 Markdown Generation

**Pattern:** Transform enriched posts to human-readable format

```typescript
const generateMarkdown = (post: EnrichedPost): string => {
  let md = `# Post by @${post.author}\n\n`
  md += `**Created:** ${post.createdAt.toISOString()}\n\n`

  // Replace mentions
  let text = post.text
  HashSet.forEach(post.mentions, (mention) => {
    text = text.replace(
      new RegExp(`@${mention}`, "g"),
      `[@${mention}](mention://${mention})`
    )
  })

  // Replace hashtags
  HashSet.forEach(post.hashtags, (tag) => {
    text = text.replace(
      new RegExp(`#${tag}`, "g"),
      `[#${tag}](tag://${tag})`
    )
  })

  // Replace links
  Chunk.forEach(post.links, (link) => {
    text = text.replace(link.href, `[${link.href}](${link.href})`)
  })

  md += text + "\n\n"

  if (HashSet.size(post.hashtags) > 0) {
    md += `**Tags:** ${Chunk.join(Chunk.fromIterable(post.hashtags), ", ")}\n`
  }

  return md
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
      const filterEngine = yield* FilterEngine

      const compiledFilter = filter ?
        yield* filterEngine.compile(parseFilterExpr(filter)) :
        FilterMonoid.empty

      const result = yield* sync.sync(
        DataSource.timeline(),
        { name: store },
        compiledFilter
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
// Cache LLM results by post content hash
const cachedClassify = yield* Cache.make({
  capacity: 10000,
  timeToLive: Duration.hours(24),
  lookup: (text: string) =>
    LanguageModel.generateObject({
      prompt: `Classify: ${text}`,
      schema: Schema.Struct({ category: Schema.String })
    }).pipe(Effect.map(r => r.value.category))
})

const classifyPost = (post: Post) => cachedClassify.get(post.text)
```

### 7.2 Type Class Usage

**Filterable for Streams:**

```typescript
import { Filterable } from "@effect/typeclass/Filterable"

// Partition stream by predicate
const [tech, other] = yield* timeline.pipe(
  Stream.partition((post) =>
    HashSet.has(post.hashtags, "#tech")
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

// Good: 10 batched calls
const batches = Chunk.chunksOf(Chunk.fromIterable(posts), 10)
for (const batch of batches) {
  const sentiments = await classifyBatch(batch.map(p => p.text))
}
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
      const f1 = PostFilters.author("alice")
      const f2 = PostFilters.hashtag("#tech")
      const f3 = PostFilters.dateRange(start, end)

      const left = f1.and(f2).and(f3)
      const right = f1.and(f2.and(f3))

      // Should produce same results
      posts.forEach(post => {
        expect(left.predicate(post)).toEqual(right.predicate(post))
      })
    }
  )
)
```

---

## 10. Implementation Priorities

### Phase 1: Foundation (Week 1)
- [ ] Project setup with Effect Language Service
- [ ] Core data structures (Post, Filter interfaces)
- [ ] Schema definitions for Bluesky post parsing
- [ ] BskyClient service with authentication

### Phase 2: Filtering (Week 2)
- [ ] Filter algebra implementation (Monoid, combinators)
- [ ] Simple filters (author, hashtag, date)
- [ ] FilterEngine service
- [ ] Stream filtering pipeline

### Phase 3: Storage (Week 3)
- [ ] StorePath and Store models
- [ ] StoreManager service
- [ ] JSON/Markdown serialization
- [ ] File system operations

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
3. **Flexibility** - Mix pure, effectful, and LLM-based predicates
4. **Performance** - Lazy evaluation, short-circuit on failures

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

## 12. Open Questions

1. **Jetstream Integration** - Should we also support the effect-jetstream library for real-time firehose access?
2. **Custom Feed Generation** - Cloudflare Workers for hosting algorithm feeds?
3. **Persistence Format** - JSONL vs individual JSON files?
4. **CLI Output Format** - JSON-only, or support table formatting?
5. **Agent Memory** - Should stores track provenance (which agent/command created data)?

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

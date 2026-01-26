# Testing Strategies Research: Functional Architecture with Effect.ts

**Date:** 2026-01-25
**Status:** Research Complete
**Goal:** Synthesize testing strategies for Skygent-Bsky's Effect-based architecture

---

## Executive Summary

Skygent-Bsky's Effect.ts architecture provides exceptional testability through:
- **Layer-based dependency injection** enabling trivial service mocking
- **Pure domain logic** with algebraic data types for property-based testing
- **Typed error channels** making error path testing first-class
- **Effect's built-in test infrastructure** (@effect/vitest) with TestClock and test services

This research synthesizes best practices from Effect.ts patterns, functional programming testing literature, and modern TypeScript testing strategies to provide comprehensive recommendations for Phase 9.

---

## 1. Testing Philosophy for Functional Architecture

### 1.1 Why Functional Code Is Intrinsically Testable

[Functional design is intrinsically testable](https://blog.ploeh.dk/2015/05/07/functional-design-is-intrinsically-testable/) because:

1. **Pure Functions**: Same input always produces same output - deterministic testing
2. **No Side Effects**: No hidden state mutations to track or reset
3. **Isolation by Default**: Functions naturally isolated from dependencies
4. **Composition**: Complex behavior built from simple, testable units

In Effect.ts specifically:
- **Effect values describe computations** without executing them
- **Dependencies are explicit** in the type signature (`Effect<A, E, R>`)
- **Layer system** provides compile-time guarantee of dependency satisfaction
- **Typed errors** make failure cases first-class citizens

### 1.2 The Testing Pyramid for Effect Applications

```
         /\
        /  \  E2E Tests (CLI smoke tests)
       /____\
      /      \  Integration Tests (Layer composition, storage rebuilds)
     /________\
    /          \  Unit Tests (Pure domain logic, service behavior)
   /____________\
  /              \  Property-Based Tests (Algebraic laws, invariants)
 /__________________\
```

**Key Principle**: In functional architectures, property-based tests form the foundation because they verify mathematical properties that must hold universally.

---

## 2. Effect.ts Testing Infrastructure

### 2.1 @effect/vitest Integration

[Effect provides @effect/vitest](https://deepwiki.com/Effect-TS/effect/7.2-testing-and-property-based-testing) which enhances Vitest/Bun test with:

**Test Variants**:
- `it.effect()` - Injects TestContext (TestClock, etc.), suppresses logs
- `it.live()` - Uses real runtime (actual Clock, actual Random)
- `it.scoped()` - For tests requiring Scope (resource lifecycle)
- `it.scopedLive()` - Combines scoped + live
- `it.flakyTest()` - Retries flaky tests until success or timeout

**Property-Based Testing**:
- `it.prop()` - Integrates fast-check for property-based tests
- Automatic derivation of Arbitraries from Schema definitions
- Built-in shrinking for minimal failing examples

**Example from Skygent's existing tests**:
```typescript
const program = Effect.gen(function* () {
  const runtime = yield* FilterRuntime;
  const predicate = yield* runtime.evaluate(expr);
  return yield* predicate(samplePost);
});

const result = await Effect.runPromise(
  program.pipe(Effect.provide(runtimeLayer))
);
```

### 2.2 TestClock for Time-Dependent Tests

[TestClock](https://effect.website/docs/testing/testclock/) enables deterministic time testing:

```typescript
it.effect("adjusts time for scheduled operations", () =>
  Effect.gen(function*() {
    yield* TestClock.adjust("1000 millis")
    yield* Clock.currentTimeMillis // Returns 1000, not actual time
  })
)
```

**Applications in Skygent**:
- Testing retry policies with baseDelay
- Testing sync pipeline scheduling
- Testing rate limiting behavior

### 2.3 Layer-Based Test Doubles

Effect's Layer system makes service mocking trivial. From reference patterns:

**Pattern 1: Test Layer with Spy**
```typescript
const makeLlmTestLayer = () => {
  const calls: Array<ReadonlyArray<LlmDecisionRequest>> = [];
  const resolver = RequestResolver.makeBatched<LlmDecisionRequest, never>(
    (requests) => Effect.gen(function* () {
      calls.push(requests); // Spy on calls
      yield* Effect.forEach(
        requests,
        (request) => Request.succeed(request, /* test response */),
        { discard: true }
      );
    })
  );
  return { layer: Layer.sync(LlmDecision, () => /* ... */), calls };
};
```

**Pattern 2: MockConsole Service**
```typescript
// From Effect CLI tests
export const MockConsole = Context.GenericTag<Console.Console, MockConsole>(
  "effect/Console"
);

export const make = Effect.gen(function*() {
  const lines = yield* Ref.make(Array.empty<string>());

  const getLines: MockConsole["getLines"] = () => Ref.get(lines);
  const log: MockConsole["log"] = (...args) =>
    Ref.update(lines, Array.appendAll(args));

  return MockConsole.of({
    [Console.TypeId]: Console.TypeId,
    getLines,
    log,
    // ... other console methods as Effect.void
  });
});
```

**Pattern 3: Inline Test Doubles**
```typescript
const testLayer = Layer.succeed(
  BskyClient,
  BskyClient.of({
    fetchPost: () => Effect.succeed(sampleRawPost),
    streamPosts: () => Stream.make(sampleRawPost)
  })
);
```

---

## 3. Property-Based Testing for Algebraic Structures

### 3.1 Why Property-Based Testing Matters

[Property-based testing](https://medium.com/@LRNZ09/property-based-testing-a-hands-on-introduction-with-typescript-c4d0703a5772) verifies properties that must hold for all valid inputs, rather than specific examples:

- **Discovers edge cases** developers wouldn't think to test
- **Tests invariants** (algebraic laws like associativity)
- **Provides better coverage** with fewer test cases
- **Documents behavior** through properties rather than examples

### 3.2 Algebraic Laws to Test in Skygent

#### Filter Combinators

**Associativity**:
```typescript
it.prop(
  "And combinator is associative",
  [FilterArbitrary, FilterArbitrary, FilterArbitrary, PostArbitrary],
  ([f1, f2, f3, post]) => {
    const left = And(And(f1, f2), f3);
    const right = And(f1, And(f2, f3));
    // Both should evaluate to same result
    assertEqual(eval(left, post), eval(right, post));
  }
);
```

**Identity Laws**:
```typescript
it.prop("All is identity for And", [FilterArbitrary, PostArbitrary], ([f, post]) => {
  assertEqual(eval(And(All, f), post), eval(f, post));
  assertEqual(eval(And(f, All), post), eval(f, post));
});

it.prop("None is identity for Or", [FilterArbitrary, PostArbitrary], ([f, post]) => {
  assertEqual(eval(Or(None, f), post), eval(f, post));
  assertEqual(eval(Or(f, None), post), eval(f, post));
});
```

**De Morgan's Laws**:
```typescript
it.prop("De Morgan: Not(And(a,b)) = Or(Not(a), Not(b))",
  [FilterArbitrary, FilterArbitrary, PostArbitrary],
  ([a, b, post]) => {
    const left = Not(And(a, b));
    const right = Or(Not(a), Not(b));
    assertEqual(eval(left, post), eval(right, post));
  }
);
```

**Commutativity** (where applicable):
```typescript
it.prop("And is commutative", [FilterArbitrary, FilterArbitrary, PostArbitrary],
  ([f1, f2, post]) => {
    assertEqual(eval(And(f1, f2), post), eval(And(f2, f1), post));
  }
);
```

#### Schema Round-Trip Properties

```typescript
it.prop("FilterSpec roundtrips through JSON", [FilterSpecArbitrary], (spec) => {
  const encoded = Schema.encodeSync(FilterSpec)(spec);
  const decoded = Schema.decodeSync(FilterSpec)(encoded);
  assertEqual(spec, decoded);
});
```

### 3.3 Schema-Derived Arbitraries

[Effect's Arbitrary module](https://deepwiki.com/Effect-TS/effect/7.2-testing-and-property-based-testing) auto-generates test data from Schema definitions:

```typescript
import { FastCheck } from "effect";

// Automatically derives arbitrary from Post schema
const PostArbitrary = FastCheck.make(Post);

// Custom arbitrary with constraints
const FilterArbitrary = FastCheck.make(FilterExprSchema).pipe(
  fc.filter(expr => depth(expr) <= 5) // Prevent stack overflow
);
```

**From Skygent's existing structure**:
```typescript
class Letter extends Schema.Class<Letter>("Letter")({
  name: Schema.String.pipe(
    Schema.minLength(1),
    Schema.filter((s) => s.match(/^[a-z]+$/) !== null)
  ),
  age: Schema.Int.pipe(Schema.between(1, 77))
}) {
  static Array = Schema.Array(this)
}

// Arbitrary automatically respects constraints!
it.prop("should sort letters", [Letter.Array], ([letters]) => {
  // Property test implementation
});
```

---

## 4. Testing Effectful Services

### 4.1 Unit Testing Pure Service Methods

From Skygent's existing test patterns:

```typescript
describe("FilterCompiler", () => {
  test("compiles author filter", async () => {
    const spec = { _tag: "Author", handle: "alice.bsky" };
    const program = Effect.gen(function* () {
      const compiler = yield* FilterCompiler;
      return yield* compiler.compile(spec);
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(FilterCompiler.layer))
    );

    expect(result._tag).toBe("Author");
  });
});
```

**Key Pattern**: Test the Effect program itself, not the implementation details.

### 4.2 Testing Error Paths

[TypeScript error handling testing](https://dev.to/supermetrics/simple-and-maintainable-error-handling-in-typescript-56lm) is first-class in Effect:

```typescript
test("propagates FilterCompileError on invalid filter", async () => {
  const invalidSpec = { _tag: "Unknown", foo: "bar" };

  const program = Effect.gen(function* () {
    const compiler = yield* FilterCompiler;
    return yield* compiler.compile(invalidSpec);
  });

  const result = await Effect.runPromise(
    Effect.either(program.pipe(Effect.provide(FilterCompiler.layer)))
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("FilterCompileError");
  }
});
```

**Pattern from Effect tests**:
```typescript
it.effect("catches all error types", () =>
  Effect.gen(function*() {
    const result = yield* Effect.exit(dangerousOperation())
    expect(result).toStrictEqual(Exit.fail(expectedError))
  })
)
```

### 4.3 Testing with Exit Values

From Effect reference patterns:

```typescript
it.effect("test success as Exit", () =>
  Effect.gen(function*() {
    const result = yield* Effect.exit(divide(4, 2))
    expect(result).toStrictEqual(Exit.succeed(2))
  })
)

it.effect("test failure as Exit", () =>
  Effect.gen(function*() {
    const result = yield* Effect.exit(divide(4, 0))
    expect(result).toStrictEqual(Exit.fail("Cannot divide by zero"))
  })
)
```

**Why Exit?** Captures both success and failure in a single test structure without throwing.

### 4.4 Testing Retry Policies

From Skygent's existing tests:

```typescript
test("retry policy propagates failure after exhausting retries", async () => {
  const expr = decodeExpr({
    _tag: "Llm",
    prompt: "Any prompt",
    minConfidence: 0.6,
    onError: {
      _tag: "Retry",
      maxRetries: 1,
      baseDelay: { _tag: "Millis", millis: 1 }
    }
  });

  const program = Effect.gen(function* () {
    const runtime = yield* FilterRuntime;
    const predicate = yield* runtime.evaluate(expr);
    return yield* predicate(samplePost);
  });

  const result = await Effect.runPromise(
    Effect.either(program.pipe(Effect.provide(failingLlmLayer)))
  );

  expect(Either.isLeft(result)).toBe(true);
});
```

**With TestClock** (enhanced version):
```typescript
it.effect("retries with exponential backoff", () =>
  Effect.gen(function*() {
    let attempts = 0;
    const failingService = Layer.succeed(Service, {
      operation: Effect.sync(() => {
        attempts++;
        throw new Error("fail");
      })
    });

    yield* Effect.retry(operation, Schedule.exponential("100 millis"))
      .pipe(Effect.provide(failingService), Effect.flip);

    // Fast-forward time instead of waiting
    yield* TestClock.adjust("1000 millis");

    expect(attempts).toBeGreaterThan(1);
  })
)
```

---

## 5. Integration Testing Strategies

### 5.1 Layer Composition Testing

[Managing Layers in Effect](https://effect.website/docs/requirements-management/layers/) tests dependency graphs:

```typescript
describe("Layer composition", () => {
  it.effect("provides all dependencies", () =>
    Effect.gen(function*() {
      // AppLayer = FilterCompiler + FilterRuntime + LlmDecision + PostParser
      const result = yield* Effect.all({
        compiler: FilterCompiler,
        runtime: FilterRuntime,
        parser: PostParser
      }).pipe(Effect.provide(AppLayer));

      // All services available
      expect(result.compiler).toBeDefined();
      expect(result.runtime).toBeDefined();
      expect(result.parser).toBeDefined();
    })
  );
});
```

### 5.2 Storage Integration Tests

```typescript
describe("EventLog rebuild", () => {
  it.scoped("rebuilds index from event log", () =>
    Effect.gen(function*() {
      const log = yield* EventLog;
      const index = yield* PostIndex;

      // Write events
      yield* log.append(PostEvent.make({ /* ... */ }));
      yield* log.append(PostEvent.make({ /* ... */ }));

      // Clear and rebuild index
      yield* index.clear();
      yield* index.rebuild();

      // Verify rebuild
      const posts = yield* index.query(StoreQuery.make({ /* ... */ }));
      expect(Array.from(posts).length).toBe(2);
    }).pipe(Effect.provide(TestStorageLayer))
  );
});
```

**Key Pattern**: Use `it.scoped()` for tests that acquire/release resources.

### 5.3 Contract Testing for External APIs

[API Contract Testing in 2026](https://www.accelq.com/blog/api-contract-testing/) ensures Bluesky API compatibility:

```typescript
describe("BskyClient contract", () => {
  test("fetchPost returns expected shape", async () => {
    const program = Effect.gen(function* () {
      const client = yield* BskyClient;
      const rawPost = yield* client.fetchPost(PostUri.make("at://..."));

      // Contract: RawPost must decode to Post
      return yield* Schema.decode(Post)(
        Schema.encode(PostFromRaw)(rawPost)
      );
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(BskyClient.Live))
    );

    expect(result).toBeDefined();
  });
});
```

**Strategy**: Use real API for contract tests, but mock for unit tests.

### 5.4 End-to-End CLI Tests

```typescript
describe("CLI smoke tests", () => {
  test("skygent sync runs successfully", async () => {
    const program = Effect.gen(function* () {
      const cli = yield* makeCliApp();
      const exitCode = yield* cli(["sync", "--store", "test-store"]);
      return exitCode;
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(TestAppLayer))
    );

    expect(result).toBe(0);
  });
});
```

---

## 6. Test Organization and Best Practices

### 6.1 Test Structure (Current Skygent Pattern)

```
tests/
├── domain/           # Pure domain logic tests
│   ├── filter.test.ts
│   ├── primitives.test.ts
│   └── raw-post.test.ts
├── services/         # Service behavior tests
│   ├── filter-compiler.test.ts
│   ├── filter-runtime.test.ts
│   └── bsky-client.test.ts
├── integration/      # Layer composition, storage
│   └── pipeline.test.ts
└── e2e/              # CLI smoke tests
    └── cli.test.ts
```

### 6.2 Bun Test Best Practices

[Bun's Test Runner in 2026](https://bun.com/docs/test) recommendations:

1. **Import from `bun:test`** not `vitest` (unless using @effect/vitest)
2. **Use TypeScript directly** - no compilation step needed
3. **Keep tests fast** - avoid slow I/O in unit tests
4. **Leverage watch mode** - `bun test --watch`
5. **Use snapshots sparingly** - prefer explicit assertions

**Skygent's package.json scripts**:
```json
{
  "test": "bun test",
  "test:watch": "bun test --watch"
}
```

### 6.3 Test Layer Patterns

**Pattern 1: Inline Test Layer**
```typescript
const testLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(LlmDecision.testLayer)
);
```

**Pattern 2: Shared Test Layer with layer()**
```typescript
layer(TestStorageLayer)("storage tests", (it) => {
  it.effect("test 1", () => /* storage available */);
  it.effect("test 2", () => /* storage available */);
});
```

**Pattern 3: Test Fixtures**
```typescript
const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #effect",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#effect"],
  mentions: [],
  links: []
});
```

---

## 7. Testing Recommendations for Phase 9

### 7.1 Priority 1: Property-Based Tests for Filter Laws

```typescript
// tests/domain/filter-laws.test.ts
import { it } from "@effect/vitest";
import { FastCheck } from "effect";

const FilterArb = FastCheck.make(FilterExprSchema);
const PostArb = FastCheck.make(Post);

describe("Filter algebraic laws", () => {
  it.prop(
    "And is associative",
    [FilterArb, FilterArb, FilterArb, PostArb],
    async ([f1, f2, f3, post], ctx) => {
      const runtime = await makeTestRuntime();
      const left = await runtime.eval(And(And(f1, f2), f3), post);
      const right = await runtime.eval(And(f1, And(f2, f3)), post);
      ctx.expect(left).toBe(right);
    }
  );

  // Add: Identity, Commutativity, De Morgan's, etc.
});
```

### 7.2 Priority 2: Storage Rebuild Tests

```typescript
// tests/integration/storage-rebuild.test.ts
describe("EventLog + PostIndex", () => {
  it.scoped("rebuilds index from event log", () =>
    Effect.gen(function*() {
      const log = yield* EventLog;
      const index = yield* PostIndex;

      // Append 100 events
      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => makePostEvent(i)),
        (event) => log.append(event),
        { discard: true }
      );

      // Clear index
      yield* index.clear();

      // Rebuild from log
      yield* index.rebuild();

      // Verify count
      const count = yield* index.count();
      expect(count).toBe(100);
    }).pipe(Effect.provide(TestStorageLayer))
  );
});
```

### 7.3 Priority 3: CLI Integration Smoke Tests

```typescript
// tests/e2e/cli-smoke.test.ts
describe("CLI commands", () => {
  test("sync command runs without error", async () => {
    const program = Effect.gen(function* () {
      const cli = yield* CliApp;
      return yield* cli(["sync", "--store", "test-store", "--limit", "10"]);
    });

    const exitCode = await Effect.runPromise(
      program.pipe(Effect.provide(TestAppLayer))
    );

    expect(exitCode).toBe(0);
  });

  test("query command outputs JSON", async () => {
    const mockConsole = yield* MockConsole.make;

    const program = Effect.gen(function* () {
      const cli = yield* CliApp;
      yield* cli(["query", "--store", "test-store", "--format", "json"]);
      return yield* mockConsole.getLines();
    });

    const lines = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.merge(TestAppLayer, mockConsole)))
    );

    const parsed = JSON.parse(lines.join(""));
    expect(parsed).toHaveProperty("posts");
  });
});
```

### 7.4 Priority 4: Error Path Coverage

```typescript
// tests/services/error-handling.test.ts
describe("Error handling", () => {
  it.effect("FilterCompileError contains source location", () =>
    Effect.gen(function*() {
      const badSpec = { _tag: "Invalid" };
      const result = yield* Effect.exit(
        FilterCompiler.compile(badSpec).pipe(
          Effect.provide(FilterCompiler.layer)
        )
      );

      expect(Exit.isFailure(result)).toBe(true);
      const cause = Exit.causeOption(result);
      const error = Cause.failureOption(cause);
      expect(error._tag).toBe("FilterCompileError");
      expect(error.message).toContain("Invalid");
    })
  );
});
```

---

## 8. Advanced Testing Patterns

### 8.1 Mutation Testing

[Mutation testing](https://en.wikipedia.org/wiki/Mutation_testing) measures test suite quality:

**Concept**: Introduce bugs (mutations) and verify tests catch them.

**Tools for TypeScript**:
- Stryker Mutator
- ts-mutate

**Application to Skygent**: Run mutation testing on core filter evaluation logic to ensure property tests catch edge cases.

### 8.2 Snapshot Testing (Use Sparingly)

```typescript
test("CLI help output format", async () => {
  const mockConsole = yield* MockConsole.make;

  const program = Effect.gen(function* () {
    const cli = yield* CliApp;
    yield* cli(["--help"]);
    return yield* mockConsole.getLines();
  });

  const output = await Effect.runPromise(
    program.pipe(Effect.provide(testLayer))
  );

  expect(output.join("\n")).toMatchSnapshot();
});
```

**When to use**: CLI output formatting, error message formatting.
**When NOT to use**: Domain logic, business rules.

### 8.3 Testing Concurrent Operations

```typescript
it.effect("handles concurrent filter evaluations", () =>
  Effect.gen(function*() {
    const runtime = yield* FilterRuntime;
    const predicate = yield* runtime.evaluate(complexFilter);

    // Evaluate 100 posts concurrently
    const results = yield* Effect.forEach(
      posts,
      (post) => predicate(post),
      { concurrency: "unbounded" }
    );

    expect(Array.from(results).filter(Boolean).length).toBeGreaterThan(0);
  }).pipe(Effect.provide(runtimeLayer))
)
```

---

## 9. Continuous Integration Setup

### 9.1 CI Test Strategy

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - run: bun install
      - run: bun test
      - run: bun run typecheck

      # Property-based tests with more iterations
      - run: bun test --filter="*.prop.*" --runs=1000
```

### 9.2 Test Coverage Goals

- **Unit tests**: 80%+ coverage for services and domain
- **Integration tests**: All critical paths (sync pipeline, query)
- **Property tests**: All algebraic structures (filters, schemas)
- **E2E tests**: Smoke tests for all CLI commands

### 9.3 Performance Benchmarks

```typescript
describe.skip("benchmarks", () => {
  test("filter evaluation throughput", async () => {
    const start = performance.now();

    const program = Effect.gen(function* () {
      const runtime = yield* FilterRuntime;
      const predicate = yield* runtime.evaluate(complexFilter);

      yield* Effect.forEach(
        largePosts,
        (post) => predicate(post),
        { concurrency: 10, discard: true }
      );
    });

    await Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)));

    const duration = performance.now() - start;
    console.log(`Evaluated ${largePosts.length} posts in ${duration}ms`);
    expect(duration).toBeLessThan(5000); // 5s threshold
  });
});
```

---

## 10. Testing Anti-Patterns to Avoid

### 10.1 Don't Test Implementation Details

**Bad**:
```typescript
test("FilterRuntime uses correct internal state", () => {
  const runtime = new FilterRuntimeLive();
  expect(runtime.cache).toBeDefined(); // Implementation detail!
});
```

**Good**:
```typescript
it.effect("FilterRuntime evaluates filter correctly", () =>
  Effect.gen(function*() {
    const runtime = yield* FilterRuntime;
    const result = yield* runtime.evaluate(filter).pipe(
      Effect.flatMap(pred => pred(post))
    );
    expect(result).toBe(true);
  })
);
```

### 10.2 Don't Mock What You Don't Own

**Bad**: Mocking Bun's file system or Effect's primitives.

**Good**: Wrap external APIs in your own service, then mock your service.

```typescript
// services/file-system.ts
export class FileSystem extends Effect.Service<FileSystem>()("FileSystem", {
  effect: Effect.sync(() => ({
    readFile: (path: string) => Effect.promise(() => Bun.file(path).text()),
    writeFile: (path: string, content: string) =>
      Effect.promise(() => Bun.write(path, content))
  }))
}) {}

// tests/services/file-system.test.ts
const testLayer = Layer.succeed(FileSystem, FileSystem.of({
  readFile: () => Effect.succeed("test content"),
  writeFile: () => Effect.void
}));
```

### 10.3 Don't Use Magic Values

**Bad**:
```typescript
const post = { uri: "foo", author: "bar", text: "baz", /* ... */ };
```

**Good**:
```typescript
const makeTestPost = (overrides?: Partial<Post>) =>
  Schema.decodeUnknownSync(Post)({
    uri: "at://did:plc:test/app.bsky.feed.post/1",
    author: "test.bsky",
    text: "Test post",
    createdAt: new Date().toISOString(),
    hashtags: [],
    mentions: [],
    links: [],
    ...overrides
  });
```

---

## 11. References and Sources

### Testing Strategies
- [Testing and Property-Based Testing | Effect-TS/effect | DeepWiki](https://deepwiki.com/Effect-TS/effect/7.2-testing-and-property-based-testing)
- [TestClock | Effect Documentation](https://effect.website/docs/testing/testclock/)
- [Understanding Property-based Testing: An Introduction With TypeScript | by Lorenzo | Medium](https://medium.com/@LRNZ09/property-based-testing-a-hands-on-introduction-with-typescript-2ljj)
- [Property Based Testing With Typescript - DEV Community](https://dev.to/mokkapps/property-based-testing-with-typescript-2ljj)

### Functional Programming Testing
- [Functional design is intrinsically testable](https://blog.ploeh.dk/2015/05/07/functional-design-is-intrinsically-testable/)
- [Algebraic Structures: Things I wish someone had explained about functional programming](https://jrsinclair.com/articles/2019/algebraic-structures-what-i-wish-someone-had-explained-about-functional-programming/)
- [Functional Programming Patterns & Design Techniques](https://softwarepatternslexicon.com/functional/)

### Effect.ts Layers and Services
- [Managing Layers | Effect Documentation](https://effect.website/docs/requirements-management/layers/)
- [Managing Services | Effect Documentation](https://effect.website/docs/requirements-management/services/)
- [From Discord: Question on `@effect/vitest` API | Issue #3718 · Effect-TS/effect](https://github.com/Effect-TS/effect/issues/3718)

### TypeScript Error Handling
- [Simple and maintainable error-handling in TypeScript - DEV Community](https://dev.to/supermetrics/simple-and-maintainable-error-handling-in-typescript-56lm)
- [Understanding Error Handling in TypeScript: Strategies and Best Practices / Blogs / Perficient](https://blogs.perficient.com/2024/06/26/understanding-error-handling-in-typescript-strategies-and-best-practices/)
- [Error handling in TypeScript like a pro](https://www.plain.com/blog/error-handling-in-typescript-like-a-pro)

### Contract Testing
- [Ultimate Guide - The Best API Contract Testing Tools of 2026](https://www.testsprite.com/use-cases/en/the-top-api-contract-testing-tools)
- [API Contract Testing: Best Practices for Developers](https://www.accelq.com/blog/api-contract-testing/)
- [The Case for Contract Testing: Cutting Through API Integration Complexity](https://pactflow.io/blog/ai-automation-part-1/)

### Bun Testing
- [How to run tests with Bun](https://www.educative.io/answers/how-to-run-tests-with-bun)
- [Test runner - Bun](https://bun.com/docs/test)
- [Bun's Test Runner: The Future of JavaScript Testing?](https://www.thegreenreport.blog/articles/buns-test-runner-the-future-of-javascript-testing/buns-test-runner-the-future-of-javascript-testing.html)
- [Faster Unit Testing of TypeScript Code with Bun.sh](https://neliosoftware.com/blog/devtips-effective-and-faster-unit-testing-with-typescript-and-bun/)

---

## 12. Conclusion and Next Steps

### Key Takeaways

1. **Effect.ts provides exceptional testability** through Layers, typed errors, and @effect/vitest
2. **Property-based testing is foundational** for testing algebraic structures like filters
3. **Layer-based mocking is trivial** compared to traditional dependency injection
4. **Test error paths as first-class citizens** using Exit and Either
5. **Bun's test runner is fast and TypeScript-native** - no compilation needed

### Phase 9 Implementation Checklist

#### Week 5: Core Testing Infrastructure
- [ ] Add property-based tests for filter algebraic laws
- [ ] Add storage rebuild integration tests
- [ ] Add error path coverage for all services
- [ ] Set up CI with bun test

#### Week 6: Integration and E2E
- [ ] Add Layer composition integration tests
- [ ] Add CLI smoke tests with MockConsole
- [ ] Add contract tests for BskyClient
- [ ] Add performance benchmarks (optional)

#### Week 7+: Hardening
- [ ] Run mutation testing on core logic
- [ ] Achieve 80%+ test coverage
- [ ] Document testing patterns in TESTING.md
- [ ] Add pre-commit hook for test execution

### Success Criteria

- All tests pass via `bun test`
- Property tests verify filter associativity, identity, and commutativity
- Storage rebuild tests verify log integrity
- CLI smoke tests cover all commands
- Error paths are explicitly tested for all services
- CI pipeline runs tests on every commit
